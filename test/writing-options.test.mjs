import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import MarkdownIt from "markdown-it";
import { markdownPairEdit, defaultExtension, saveLineEnding } from "../src/core/writing-options.js";
import { parseInline } from "../src/core/inline.js";
import { readableMarkdown } from "../src/core/readable.js";
import { buildNativeExport } from "../src/renderer/native-export.js";

const dom = new JSDOM('<!doctype html><body><div id="write" contenteditable="true" tabindex="0"></div></body>', { url: "http://localhost/", pretendToBeVisual: true });
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const { Editor, blockSourceFromEl } = await import("../src/renderer/editor.js");
const { doEnter } = await import("../src/renderer/editor-input.js");
const editor = new Editor({ root: document.getElementById("write") });
const app = window.__lettrine = { settings: {}, editor }; window.markdownit = MarkdownIt;
window.bridge = { theme: { resolve: async () => ({}) }, native: { invoke: async () => ({ text: "", data: "", mime: "text/css" }) } };
const load = (source, settings = {}) => {
  app.settings = settings; editor.__settings = settings; editor._markdownPair = null;
  editor.setReadOnly(false); editor.setText(source); editor.root.focus(); editor.selectOffsets(source.length);
};
const type = (text) => { for (const char of text) {
  const event = new window.InputEvent("beforeinput", { inputType: "insertText", data: char, cancelable: true });
  editor.handleBeforeInput(event);
  if (!event.defaultPrevented) editor.replaceSelection(char, { inputType: "insertText" });
} };

test("writing options: file defaults, detected line endings and per-document overrides have independent precedence", () => {
  assert.equal(defaultExtension(), "md"); assert.equal(defaultExtension({ defaultExtension: "QMD" }), "qmd");
  assert.equal(defaultExtension({ defaultExtension: "../bad" }), "md");
  assert.equal(saveLineEnding({}, "CRLF", ""), "CRLF");
  assert.equal(saveLineEnding({ lineEndings: "LF" }, "CRLF", ""), "LF");
  assert.equal(saveLineEnding({ lineEndings: "LF" }, "LF", "CRLF"), "CRLF");
  assert.equal(saveLineEnding({ lineEndings: "LF" }, "CRLF", "preserve"), "CRLF");
});

test("writing options: marker completion is opt-in, respects escaping and preserves exact typed Markdown", () => {
  load(""); type("*"); assert.equal(editor.getMarkdown(), "*");
  for (const text of ["*italic*", "**bold**", "_emphasis_", "__strong__", "`code`", "~~strike~~", "Text ~~strike~~", "# Heading", "## Heading", "> Quote"]) {
    load("", { autoPairMarkdown: true }); type(text);
    assert.equal(editor.getMarkdown(), text);
    assert.equal(blockSourceFromEl(editor.root.firstElementChild), editor.blocks[0].src);
  }
  assert.equal(markdownPairEdit("\\", { start: 1, end: 1 }, "*"), null);
  assert.equal(markdownPairEdit("file_name", { start: 4, end: 4 }, "_"), null);
  load("word", { autoPairMarkdown: true }); editor.selectOffsets(0, 4); type("*");
  assert.equal(editor.getMarkdown(), "*word*"); assert.deepEqual(editor.selectionOffsets(), { start: 1, end: 5, backward: false });
  editor.undo(); assert.equal(editor.getMarkdown(), "word");
  load("```js\nliteral\n```", { autoPairMarkdown: true }); editor.selectOffsets(13); type("*"); assert.equal(editor.getMarkdown(), "```js\nliteral*\n```");
  load("$$\nx\n$$", { autoPairMarkdown: true }); editor.selectOffsets(4); type("_"); assert.equal(editor.getMarkdown(), "$$\nx_\n$$");
});

test("writing options: triple backticks create a paired fence and Enter enters its body without changing source", () => {
  load("", { autoPairMarkdown: true, defaultCodeLanguage: "js" }); type("```");
  assert.equal(editor.getMarkdown(), "```js"); assert.equal(editor.selectionOffsets().start, 5);
  doEnter(editor); assert.equal(editor.getMarkdown(), "```js\n\n```"); assert.equal(editor.selectionOffsets().start, 6);
  editor.undo(); assert.equal(editor.getMarkdown(), "```js");
});

test("writing options: empty heading and quote focus uses decoration and keeps neighboring DOM and source", () => {
  for (const source of ["## \n\nAfter", "> \n\nAfter"]) {
    load(source); const after = editor.root.lastElementChild;
    editor.selectOffsets(source.indexOf("\n")); editor._syncSimpleBlockFocus();
    assert.ok(editor.root.firstElementChild.classList.contains("md-simple-focus"));
    assert.equal(editor.getMarkdown(), source); assert.equal(blockSourceFromEl(editor.root.firstElementChild), editor.blocks[0].src);
    editor.__settings = { autoExpandSimple: false }; editor._syncSimpleBlockFocus();
    assert.equal(editor.root.querySelector(".md-simple-focus"), null);
    assert.equal(editor.root.lastElementChild, after);
  }
});

test("writing options: HTML breaks retain spelling outside code and heading break display can collapse independently", async () => {
  const source = "# Two<br/>parts\n\nBody<BR />next and `<br>`\n\n> Inside<br>quote";
  load(source, { ignoreHeadingBreaks: true });
  assert.equal(editor.getMarkdown(), source);
  assert.equal(editor.root.querySelector("h1 br"), null); assert.ok(editor.root.querySelector("p br"));
  assert.equal(editor.root.querySelectorAll(".md-html-br").length, 3);
  assert.equal(parseInline("`<br>`")[0].type, "code"); assert.equal(readableMarkdown("first<br/>second"), "first\nsecond");
  assert.equal(readableMarkdown("**first<br/>second**"), "first\nsecond");
  const html = await buildNativeExport({ text: source, style: false, settings: { ignoreHeadingBreaks: true } });
  const document = new window.DOMParser().parseFromString(html, "text/html");
  assert.equal(document.querySelector("h1").textContent, "Two parts");
  assert.equal(document.querySelector("h1 br"), null); assert.equal(document.querySelectorAll("p br").length, 2);
  assert.equal(document.querySelector("code").textContent, "<br>");
});
