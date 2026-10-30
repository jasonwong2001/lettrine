import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import MarkdownIt from "markdown-it";
import katex from "katex";
import { parseInline, segmentsToHtml } from "../src/core/inline.js";
import { buildNativeExport } from "../src/renderer/native-export.js";
import { htmlToMarkdown } from "../src/renderer/html-to-markdown.js";
import { imageCopyPayload } from "../src/renderer/copy-image.js";
import { parseBlocks } from "../src/core/blocks.js";
import { readableMarkdown } from "../src/core/readable.js";
import { documentStats } from "../src/core/stats.js";

const settings = { subscriptSuperscript: true };
test("scripts: opt-in syntax, escaped markers, whitespace and math/code boundaries", () => {
  assert.equal(parseInline("H~2~O X^2^").some((part) => ["subscript", "superscript"].includes(part.type)), false);
  assert.deepEqual(parseInline("H~2~O X^2^", settings).filter((part) => part.inner).map((part) => [part.type, part.inner]), [["subscript", "2"], ["superscript", "2"]]);
  const source = String.raw`~~strike~~ X^^2^^ ~two words~ \~literal~ \^literal^ $a^2^+b_2$ ` + "`H~2~O X^2^`";
  const parts = parseInline(source, settings);
  assert.equal(parts.filter((part) => part.type === "strike").length, 1);
  assert.equal(parts.filter((part) => part.type === "subscript" || part.type === "superscript").length, 0);
  assert.equal(parts.map((part) => part.src).join(""), source);
  assert.equal(parseInline(String.raw`^two\ words^`, settings)[0].type, "superscript");
  const html = segmentsToHtml(parseInline("X^$a^2$^ 中~文~本", settings), undefined, settings);
  const doc = new JSDOM(html).window.document;
  assert.ok(doc.querySelector("sup .md-inline-math"));
  assert.ok(doc.querySelector("sub"));
});

const dom = new JSDOM('<!doctype html><body><div id="md-content"><div id="write" contenteditable="true" tabindex="0"></div></div>', { pretendToBeVisual: true, url: "http://localhost/" });
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
window.katex = katex; window.markdownit = MarkdownIt;
window.__lettrine = { settings: { ...settings }, theme: "lettrine", file: "/tmp/scripts.md" };
window.bridge = { theme: { resolve: async () => ({}) }, native: { invoke: async () => ({ text: "", data: "", mime: "text/css" }) } };
const { Editor, blockSourceFromEl } = await import("../src/renderer/editor.js");
const { formatSubscript, formatSuperscript, clearFormat } = await import("../src/renderer/editor-ops.js");
const editor = new Editor({ root: document.getElementById("write") });
window.__lettrine.editor = editor;
function setText(text, options = settings) {
  editor.setReadOnly(false); editor.__settings = { ...options }; window.__lettrine.settings = editor.__settings;
  editor.setText(text); editor.root.focus();
}
const textOf = (node) => { const copy = node.cloneNode(true); for (const marker of copy.querySelectorAll(".md-attr")) marker.remove(); return copy.textContent; };

test("scripts: nested styling, quotes, tables and HTML spellings round-trip exactly", () => {
  const source = "# H~2~O\n\n~~H~2~O~~ and **X^2^** and <SUB><u>words here</u></SUB>.\n\n> CO~2~\n\n| X^2^ |\n| --- |\n| H~2~O |";
  setText(source);
  assert.ok(editor.root.querySelector("s sub"));
  assert.ok(editor.root.querySelector("strong sup"));
  assert.equal(textOf(editor.root.querySelector("sub u")), "words here");
  for (let i = 0; i < editor.blocks.length; i++) assert.equal(blockSourceFromEl(editor.root.children[i]), editor.blocks[i].src);
  assert.equal(editor.getMarkdown(), source);
  window.__lettrine.settings.subscriptSuperscript = false; editor.renderAll({ full: true });
  assert.equal(editor.root.querySelector("sub, sup"), null);
  assert.equal(editor.getMarkdown(), source);
});

test("scripts: formatting toggles at inner and outer boundaries, escapes spaces and supports empty insertion", () => {
  setText("H2O");
  editor.selectOffsets(1, 2); formatSubscript(editor);
  assert.equal(editor.getMarkdown(), "H~2~O");
  assert.deepEqual(editor.selectionOffsets(), { start: 2, end: 3, backward: false });
  formatSubscript(editor); assert.equal(editor.getMarkdown(), "H2O");
  editor.undo(); assert.equal(editor.getMarkdown(), "H~2~O");
  editor.selectOffsets(1, 4); formatSubscript(editor); assert.equal(editor.getMarkdown(), "H2O");
  setText("two words"); editor.selectOffsets(0, 9); formatSuperscript(editor);
  assert.equal(editor.getMarkdown(), String.raw`^two\ words^`);
  assert.equal(textOf(editor.root.querySelector("sup")), "two words");
  formatSuperscript(editor); assert.equal(editor.getMarkdown(), "two words");
  setText("X"); editor.selectOffsets(1); formatSuperscript(editor); editor.replaceSelection("2");
  assert.equal(editor.getMarkdown(), "X^2^");
  assert.equal(textOf(editor.root.querySelector("sup")), "2");
});

test("scripts: adjacent strike delimiters use HTML without turning the block into a fence", () => {
  setText("~~strike~~"); editor.selectOffsets(0, 10); formatSubscript(editor);
  assert.equal(editor.getMarkdown(), "<sub>~~strike~~</sub>");
  assert.equal(editor.blocks[0].type, "paragraph");
  assert.ok(editor.root.querySelector("sub s"));
  formatSubscript(editor); assert.equal(editor.getMarkdown(), "~~strike~~");
  editor.undo(); assert.ok(editor.root.querySelector("sub s"));
  editor.setReadOnly(true); const source = editor.getMarkdown(), count = editor._history.length;
  formatSuperscript(editor); assert.equal(editor.getMarkdown(), source); assert.equal(editor._history.length, count);
});

test("scripts: clear formatting, rich paste and image copies preserve the visible text", () => {
  setText("H~2~O X^2^"); editor.selectOffsets(0, 0); clearFormat(editor);
  assert.equal(editor.getMarkdown(), "H2O X2");
  const pasted = htmlToMarkdown("<p>H<sub>2</sub>O X<sup>two words</sup> literal ^2^</p>", document, settings);
  assert.equal(pasted, String.raw`H<sub>2</sub>O X<sup>two words</sup> literal \^2\^`);
  setText(pasted); editor.selectAll();
  const copy = new JSDOM(imageCopyPayload(window.__lettrine).fragment).window.document;
  assert.equal(copy.querySelector("sub").textContent, "2");
  assert.equal(copy.querySelector("sup").textContent, "two words");
  assert.equal(copy.querySelector(".md-attr"), null);
  assert.equal(editor.getMarkdown(), pasted);
});

test("scripts: reading and word counts follow the setting even when the source is unchanged", () => {
  const source = "H~2~O <sub>small</sub>", blocks = parseBlocks(source);
  const plain = documentStats(blocks);
  assert.equal(readableMarkdown(source, settings), "H2O small");
  assert.equal(documentStats(blocks, undefined, settings).words, 2);
  assert.deepEqual(documentStats(blocks), plain);
  assert.equal(documentStats(blocks, undefined, settings).words, 2);
  assert.equal(documentStats(blocks, undefined, settings).chars, source.length);
  setText(source); editor.selectOffsets(0);
  assert.equal(editor.getSpeechText(), "H2O small");
});

test("scripts: standalone exports follow the toggle and preserve nested marks, math and code", async () => {
  const source = String.raw`H~2~O **X^2^** ^two\ words^ <sub>~~strike~~</sub> $a^2$ ` + "`X^2^`";
  const enabled = new JSDOM(await buildNativeExport({ text: source, settings })).window.document;
  assert.equal(enabled.querySelector("sub").textContent, "2");
  assert.equal(enabled.querySelector("strong sup").textContent, "2");
  assert.ok(Array.from(enabled.querySelectorAll("sup")).some((node) => node.textContent === "two words"));
  assert.ok(enabled.querySelector("sub s"));
  assert.ok(enabled.querySelector(".katex"));
  assert.equal(enabled.querySelector("code").textContent, "X^2^");
  const disabled = new JSDOM(await buildNativeExport({ text: "H~2~O X^2^", settings: {} })).window.document;
  assert.equal(disabled.querySelector("sub, sup"), null);
  assert.equal(disabled.querySelector("p").textContent, "H~2~O X^2^");
});
