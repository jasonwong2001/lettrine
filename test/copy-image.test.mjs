import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import katex from "katex";
import { imageCopyPayload } from "../src/renderer/copy-image.js";

const dom = new JSDOM('<!doctype html><html><body><div id="md-content"><div id="write" contenteditable="true" tabindex="0"></div></div><textarea id="source-editor"></textarea></body></html>', { pretendToBeVisual: true, url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
window.katex = katex;
window.__lettrine = { settings: {} };
const { Editor } = await import("../src/renderer/editor.js");
const app = window.__lettrine;
app.editor = new Editor({ root: document.getElementById("write") });
app.theme = "lettrine";
app.file = "/tmp/document.md";
function select(source, start = 0, end = source.length) {
  document.body.classList.remove("sourceview-on", "ui-dark");
  app.editor.setReadOnly(false);
  app.editor.setText(source);
  app.editor.root.focus();
  app.editor.selectOffsets(start, end);
}
function fragment(payload) {
  const template = document.createElement("template");
  template.innerHTML = payload.fragment;
  return template.content;
}

test("image copy retains a partial selection's heading and nested marks without editing", () => {
  const source = "## Heading with **selected word** here";
  const start = source.indexOf("selected");
  select(source, start, start + 8);
  const before = app.editor.selectionOffsets(), history = app.editor._history.length;
  const output = fragment(imageCopyPayload(app));
  assert.equal(output.querySelector("h2 strong").textContent, "selected");
  assert.equal(output.textContent, "selected");
  assert.equal(output.querySelector(".md-attr"), null);
  assert.equal(app.editor.getMarkdown(), source);
  assert.equal(app.editor._history.length, history);
  assert.deepEqual(app.editor.selectionOffsets(), before);
});

test("image copy joins multiple blocks with alerts, table alignment and no editing controls", () => {
  const source = "> [!WARNING]\n> **Careful**.\n\n| Left | Right |\n| :--- | ---: |\n| One | Two |";
  select(source);
  app.editor.setReadOnly(true);
  const output = fragment(imageCopyPayload(app));
  assert.ok(output.querySelector(".md-alert-warning .md-alert-title svg"));
  assert.ok(output.querySelector(".md-alert-warning strong"));
  assert.equal(output.querySelectorAll("table tr").length, 2);
  assert.equal(output.querySelector("th:last-child").style.textAlign, "right");
  assert.equal(output.querySelector("button, select, .md-attr, [contenteditable]"), null);
  assert.doesNotMatch(output.textContent, /\[!WARNING\]|:---/);
  assert.equal(app.editor.getMarkdown(), source);
});

test("image copy expands a glyph selection to the complete inline formula", () => {
  const source = "Before $x^2+1$ after";
  select(source);
  const glyph = app.editor.root.querySelector(".katex .mord");
  const range = document.createRange(); range.selectNodeContents(glyph);
  const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
  const output = fragment(imageCopyPayload(app));
  assert.equal(output.querySelectorAll(".katex").length, 1);
  assert.equal(output.querySelector(".md-tex-src, .md-attr"), null);
  assert.match(output.textContent, /x/);
  assert.match(output.textContent, /1/);
  assert.doesNotMatch(output.textContent, /Before|after/);
  assert.equal(app.editor.getMarkdown(), source);
});

test("image copy uses source-mode selections and formula targets without changing modes", () => {
  const source = "Before\n\n$$\n\\frac{1}{3}\n$$\n\nAfter";
  select(source);
  document.body.classList.add("ui-dark");
  const math = imageCopyPayload(app, app.editor.root.querySelector(".md-math-body"));
  assert.equal(math.text, "$$\n\\frac{1}{3}\n$$");
  assert.equal(math.tight, true);
  assert.equal(math.dark, true);
  document.body.classList.add("sourceview-on");
  const textarea = document.getElementById("source-editor");
  textarea.value = source; textarea.setSelectionRange(0, 6);
  assert.equal(imageCopyPayload(app).text, "Before");
  assert.equal(document.body.classList.contains("sourceview-on"), true);
  assert.equal(app.editor.getMarkdown(), source);
});

test("image copy preserves the numbering of a partially selected ordered list", () => {
  const source = "4. First\n5. Second\n6. Third";
  select(source, source.indexOf("Second"), source.indexOf("Second") + 6);
  const output = fragment(imageCopyPayload(app));
  assert.equal(output.querySelector("ol").start, 5);
  assert.equal(output.querySelectorAll("li").length, 1);
  assert.equal(output.textContent, "Second");
});

test("image copy retains unresolved footnotes and broken image source as visible text", () => {
  const source = "Unknown[^missing] and ![missing](absent.png)";
  select(source);
  app.editor.root.querySelector(".md-image").classList.add("md-img-error");
  const output = fragment(imageCopyPayload(app));
  assert.equal(output.textContent, source);
  assert.equal(app.editor.getMarkdown(), source);
});
