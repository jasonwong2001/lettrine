import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import katex from "katex";
import MarkdownIt from "markdown-it";
import { markdownSpans, structuralRange, structuralDeletion } from "../src/core/selection.js";

const dom = new JSDOM('<!doctype html><body><div id="md-content"><div id="write" contenteditable="true" tabindex="0"></div></div><div id="app-source"><textarea id="source-editor"></textarea></div>', { url: "http://localhost/", pretendToBeVisual: true });
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
window.katex = katex; window.markdownit = MarkdownIt;
let clipboard, notification;
window.bridge = { path: { fileURL: (file) => "file://" + file }, clipboard: { write: async (payload) => { clipboard = payload; } }, theme: { resolve: async () => ({}) } };
const { Editor } = await import("../src/renderer/editor.js");
const { runSelectionCommand } = await import("../src/renderer/selection-tools.js");
const { specialCopyPayload, copySpecial, cleanClipboardHTML } = await import("../src/renderer/clipboard-tools.js");
const editor = new Editor({ root: document.getElementById("write") });
const app = { editor, settings: {}, i18n: { locale: "en" }, notify: (message) => { notification = message; } }; window.__lettrine = app;
const collapsed = (start) => ({ start, end: start });
const setup = (source) => {
  document.body.classList.remove("sourceview-on");
  editor.setReadOnly(false); editor.setText(source); editor.root.focus(); editor.selectOffsets(0);
  notification = ""; app.settings = {};
};
const selectedText = (source, range) => source.slice(range.start, range.end);

test("selection: block, line and sentence ranges stay inside their Markdown block", () => {
  const source = "Before\n\n## Heading\n\nOne sentence. Next sentence!\nThird line.\n\nAfter";
  const point = source.indexOf("Next"), selection = collapsed(point + 2);
  assert.equal(selectedText(source, structuralRange(source, selection, "block")), "One sentence. Next sentence!\nThird line.\n\n");
  assert.equal(selectedText(source, structuralRange(source, selection, "line")), "One sentence. Next sentence!");
  assert.equal(selectedText(source, structuralRange(source, selection, "sentence")), "Next sentence!\n");
  assert.equal(structuralRange(source, selection, "lineStart").start, source.indexOf("One"));
  assert.equal(structuralRange(source, selection, "lineEnd").start, source.indexOf("\nThird"));
  const multi = { start: source.indexOf("Before") + 2, end: source.indexOf("Next") + 2 };
  assert.equal(selectedText(source, structuralRange(source, multi, "word")), "Before\n\n## Heading\n\nOne sentence. Next");
});

test("selection: word ranges preserve Unicode graphemes and code/math delimiters", () => {
  for (const [source, point, expected] of [["Cafe\u0301 noir", 2, "Cafe\u0301"], ["one 😀 two", 5, "😀"], ["编写中文文档", 1, "编写"], ["a `long_name` z", 6, "long_name"], ["a $x$ z", 3, "x"]]) {
    assert.equal(selectedText(source, structuralRange(source, collapsed(point), "word")), expected);
  }
});

test("selection: nested inline scopes, table cells and quote offsets retain exact source positions", () => {
  const source = "> Quote **outer *inner* text** and $x^2$.\n\n| First | Second |\n| :--- | ---: |\n| a\\|b | `c|d` |";
  const inner = structuralRange(source, collapsed(source.indexOf("inner") + 2), "scope");
  assert.equal(selectedText(source, inner), "inner");
  const cell = structuralRange(source, collapsed(source.indexOf("a\\|b") + 1), "scope");
  assert.equal(selectedText(source, cell), "a\\|b");
  const scopes = markdownSpans(source);
  const math = scopes.inline.find((span) => span.kind === "math");
  assert.equal(source.slice(math.start, math.end), "$x^2$");
  const nested = markdownSpans("> ```js\n>   const x = 1;  \n> ```\n\n> $$\n> x+1\n> $$");
  assert.equal(nested.nested.find((span) => span.block.type === "code").block.body, " const x = 1;  ");
  assert.equal(nested.inline.length, 0, "raw blocks do not create misleading inline scopes");
});

test("selection: block deletion repairs separators and line deletion preserves raw-block fences", () => {
  const source = "A  \n\nB\n\nC";
  for (const [point, expected] of [[0, "B\n\nC"], [source.indexOf("B"), "A  \n\nC"], [source.indexOf("C"), "A  \n\nB"]]) {
    const range = structuralDeletion(source, collapsed(point), "block");
    assert.equal(source.slice(0, range.start) + source.slice(range.end), expected);
    const selected = structuralRange(source, collapsed(point), "block");
    const deleted = structuralDeletion(source, selected, "block");
    assert.equal(source.slice(0, deleted.start) + source.slice(deleted.end), expected);
  }
  const code = "```js\nfirst();\nlast();\n```\n\nAfter";
  for (const [word, expected] of [["first", "last();"], ["last", "first();"]]) {
    const range = structuralDeletion(code, collapsed(code.indexOf(word)), "line");
    assert.equal(code.slice(0, range.start) + code.slice(range.end), "```js\n" + expected + "\n```\n\nAfter");
  }
});

test("selection: commands on blank source lines never resolve to adjacent paragraph contents", () => {
  for (const [source, point, result] of [["A\n\nB", 2, "A\nB"], ["\n\nB", 1, "\nB"], ["A\n\n", 2, "A\n"]]) {
    assert.equal(selectedText(source, structuralRange(source, collapsed(point), "line")), "");
    assert.equal(structuralRange(source, collapsed(point), "lineStart").start, point);
    assert.equal(structuralRange(source, collapsed(point), "lineEnd").start, point);
    const range = structuralDeletion(source, collapsed(point), "line");
    assert.equal(source.slice(0, range.start) + source.slice(range.end), result);
  }
});

test("selection: preview word and sentence deletion have independent undo steps and retain other DOM nodes", () => {
  const source = "Before\n\nDelete word. Keep this.\n\nAfter";
  setup(source); editor.selectOffsets(source.indexOf("word") + 2);
  const before = editor.root.firstElementChild, after = editor.root.lastElementChild;
  assert.equal(runSelectionCommand(app, "deleteWord"), true);
  assert.equal(editor.getMarkdown(), source.replace("word", ""));
  assert.equal(editor.root.firstElementChild, before); assert.equal(editor.root.lastElementChild, after);
  editor.undo(); assert.equal(editor.getMarkdown(), source);
  editor.selectOffsets(source.indexOf("Keep") + 2);
  runSelectionCommand(app, "deleteSentence");
  assert.equal(editor.getMarkdown(), source.replace("Keep this.", ""));
  editor.undo(); assert.equal(editor.getMarkdown(), source);
});

test("selection: block selection includes the exact code fence and deleting it is undoable", () => {
  const source = "Before\n\n````js\nconst x = 1;\n``````  \n\nAfter";
  setup(source); editor.selectOffsets(source.indexOf("const"));
  runSelectionCommand(app, "selectBlock");
  const selection = editor.selectionOffsets();
  assert.equal(selectedText(source, selection), "````js\nconst x = 1;\n``````  \n\n");
  runSelectionCommand(app, "deleteBlock");
  assert.equal(editor.getMarkdown(), "Before\n\nAfter");
  editor.undo(); assert.equal(editor.getMarkdown(), source);
});

test("selection: readonly allows selection and copy, rejects deletion, and leaves dialogs and form fields alone", async () => {
  setup("A **word**."); editor.selectOffsets(5); editor.setReadOnly(true);
  runSelectionCommand(app, "selectWord");
  assert.equal(window.getSelection().toString(), "word");
  assert.equal(runSelectionCommand(app, "deleteWord"), false); assert.equal(editor.getMarkdown(), "A **word**.");
  const input = document.createElement("input"); document.body.appendChild(input); input.focus();
  assert.equal(runSelectionCommand(app, "deleteBlock"), false);
  assert.equal(await copySpecial(app, "clean"), false);
  input.remove();
  const field = document.createElement("div"); field.contentEditable = "true"; field.setAttribute("contenteditable", "true"); field.tabIndex = 0; document.body.appendChild(field); field.focus();
  assert.equal(runSelectionCommand(app, "selectBlock"), false);
  assert.equal(await copySpecial(app, "clean"), false); field.remove();
  const modal = document.createElement("div"); modal.className = "modal open"; document.body.appendChild(modal);
  assert.equal(runSelectionCommand(app, "selectBlock"), false); modal.remove();
  editor.root.focus(); editor._composing = true;
  assert.equal(runSelectionCommand(app, "selectBlock"), false);
  assert.equal(await copySpecial(app, "tex"), false); editor._composing = false;
});

test("clipboard: TeX and MathML copy exact formulas, including nested quotes and disabled rendering", async () => {
  const source = "> Formula $x^2 + 1$.\n\n$$\n\\frac{1}{2}\\label{half}\n$$";
  setup(source); editor.selectOffsets(source.indexOf("x^2") + 1); app.settings.renderMath = false;
  assert.deepEqual(await specialCopyPayload(app, "tex"), { text: "x^2 + 1" });
  const inline = await specialCopyPayload(app, "mathml"), xml = new window.DOMParser().parseFromString(inline.text, "application/xml");
  assert.equal(xml.querySelector("parsererror"), null);
  assert.equal(xml.documentElement.localName, "math"); assert.equal(inline.text, inline.html);
  editor.selectOffsets(source.indexOf("\\frac") + 2);
  assert.equal((await specialCopyPayload(app, "tex")).text, "\\frac{1}{2}\\label{half}");
  const display = await specialCopyPayload(app, "mathml");
  assert.match(display.text, /display="block"/); assert.match(display.text, /<mfrac>/); assert.doesNotMatch(display.text, /\\label/);
  assert.equal(editor.getMarkdown(), source);
});

test("clipboard: code and pipe-table copies preserve exact whitespace and ignore surrounding source", async () => {
  const body = "  const x = 1;  \n\tfinish();";
  const table = "| A | B |\n| :--- | ---: |\n| a\\|b | `c|d` |";
  const source = "Before\n\n````js\n" + body + "\n``````  \n\n" + table + "\n\nAfter";
  setup(source); editor.selectOffsets(source.indexOf("const"));
  assert.deepEqual(await specialCopyPayload(app, "code"), { text: body });
  editor.selectOffsets(source.indexOf("a\\|b"));
  assert.deepEqual(await specialCopyPayload(app, "table"), { text: table });
  setup("> " + table.replace(/\n/g, "\n> ")); editor.selectOffsets(6);
  assert.equal((await specialCopyPayload(app, "table")).text, table);
  setup("No formula"); clipboard = { text: "Previous clipboard" };
  assert.equal(await copySpecial(app, "tex"), false); assert.equal(clipboard.text, "Previous clipboard");
  assert.equal(notification, "Place the caret in a formula.");
});

test("clipboard: clean HTML keeps partial inline formatting, semantic structure and MathML without theme styles", async () => {
  setup("Before **selected** after"); editor.selectOffsets(9, 17);
  const partial = await specialCopyPayload(app, "clean");
  assert.equal(partial.text, "selected"); assert.match(partial.html, /<strong>selected<\/strong>/);
  assert.doesNotMatch(partial.html, /style=|class=|data-|md-attr|contenteditable|<script|<style/);
  setup("# Title\n\n**Strong** and $x^2$.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |");
  const whole = await specialCopyPayload(app, "clean");
  assert.match(whole.html, /<h1>Title<\/h1>/); assert.match(whole.html, /<table>/); assert.match(whole.html, /<math /);
  assert.doesNotMatch(whole.html, /style=|class=|<script|<style|id=/);
  const clean = cleanClipboardHTML('<article id="write"><p class="theme" style="color:red" onclick="bad()">Safe <a href="javascript:bad()">link</a></p><script>bad()</script></article>');
  assert.equal(clean, "<p>Safe <a>link</a></p>");
  const math = cleanClipboardHTML('<math xmlns="http://www.w3.org/1998/Math/MathML"><mpadded depth="0em" voffset=".2em"><mo movablelimits="true" largeop="true">∑</mo></mpadded></math>');
  assert.match(math, /depth="0em" voffset=".2em"/); assert.match(math, /movablelimits="true" largeop="true"/);
});

test("clipboard: selected clean HTML retains list numbering, links and portable local images", async () => {
  const source = "3. **Item** with [link](https://example.org)\n4. Next\n\n![Local](pixel.svg)";
  setup(source); editor.selectAll();
  const reads = [];
  window.bridge.native = { invoke: async (channel, payload) => {
    reads.push([channel, payload.url]);
    return { mime: "image/svg+xml", data: "cGl4ZWw=" };
  } };
  try {
    const copied = await specialCopyPayload(app, "clean");
    const fragment = document.createElement("template"); fragment.innerHTML = copied.html;
    assert.equal(fragment.content.querySelector("ol").start, 3);
    assert.equal(fragment.content.querySelector("a").getAttribute("href"), "https://example.org");
    assert.equal(fragment.content.querySelector("img").getAttribute("src"), "data:image/svg+xml;base64,cGl4ZWw=");
    assert.equal(fragment.content.querySelector("img").alt, "Local");
    assert.deepEqual(reads, [["native.asset", "pixel.svg"]]);
    assert.doesNotMatch(copied.html, /style=|class=|data-/);
    assert.equal(editor.getMarkdown(), source);
  } finally { delete window.bridge.native; }
});

test("selection and clipboard: Source Code Mode fallback uses its selection and readonly state", async () => {
  const source = "Before\n\n```js\nconst x = 1;\nfinish();\n```\n\nAfter";
  setup(source); document.body.classList.add("sourceview-on");
  const textarea = document.getElementById("source-editor"); textarea.value = source; textarea.focus();
  textarea.setSelectionRange(source.indexOf("const") + 1, source.indexOf("const") + 1);
  runSelectionCommand(app, "selectWord"); assert.equal(textarea.value.slice(textarea.selectionStart, textarea.selectionEnd), "const");
  runSelectionCommand(app, "lineEnd"); assert.equal(textarea.selectionStart, source.indexOf("\nfinish"));
  assert.equal((await specialCopyPayload(app, "code")).text, "const x = 1;\nfinish();");
  runSelectionCommand(app, "deleteLine"); assert.equal(textarea.value, source.replace("const x = 1;\n", ""));
  editor.setReadOnly(true); const before = textarea.value;
  assert.equal(runSelectionCommand(app, "deleteBlock"), false); assert.equal(textarea.value, before);
  document.body.classList.remove("sourceview-on");
});
