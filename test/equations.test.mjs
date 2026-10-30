import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import katex from "katex";
import MarkdownIt from "markdown-it";
import { parseBlocks, blocksToMarkdown } from "../src/core/blocks.js";
import { equationIndex, equationTex, equationTrust } from "../src/core/math.js";
import { equationMarkdown } from "../src/core/math-markdown.js";
import { buildNativeExport } from "../src/renderer/native-export.js";
import { imageCopyPayload } from "../src/renderer/copy-image.js";

const source = String.raw`See $\eqref{eq:energy}$ and $\eqref{eq:manual}$; missing $\eqref{absent}$.

$$ {#eq:energy}
E=mc^2
$$

$$ {A}
x=1\label{eq:manual}
$$

$$ {-}
y=2
$$

$$
z=3\label{eq:last}
$$`;
test("equations: auto tags, manual tags, opt-out and labels preserve the exact model", () => {
  const blocks = parseBlocks(source), index = equationIndex(blocks);
  assert.deepEqual(index.equations.map((entry) => entry.tag), [String.raw`\text{1}`, String.raw`\text{A}`, null, String.raw`\text{2}`]);
  assert.equal(index.labels.get("eq:energy").id, "md-equation-1");
  assert.equal(index.labels.get("eq:manual").id, "md-equation-2");
  assert.equal(blocksToMarkdown(blocks), source);
  assert.match(equationTex(String.raw`\eqref{eq:energy}+\ref{eq:manual}+\eqref{absent}`, index), /\\href\{#md-equation-1\}/);
  assert.match(equationTex(String.raw`\eqref{absent}`, index), /\(\s*\\text\{\?\?\}\)/);
  assert.deepEqual(equationIndex(blocks, { numberEquations: false }).equations.map((entry) => entry.tag), [null, String.raw`\text{A}`, null, null]);
});

test("equations: TeX tags, nested arguments, comments, duplicates and incomplete formulas", () => {
  const text = String.raw`$$
a\tag{\text{S.1}}\label{same}
$$

$$
b\label{same}\notag
$$

$$
% \label{ignored}
c\tag*{Q}\label{last}
$$

$$
unfinished`;
  const index = equationIndex(parseBlocks(text));
  assert.deepEqual(index.equations.map((entry) => [entry.tag, entry.star]), [[String.raw`\text{S.1}`, false], [null, false], ["Q", true], [null, false]]);
  assert.equal(index.labels.get("same").id, "md-equation-1");
  assert.equal(index.labels.has("ignored"), false);
  const rendered = equationTex(index.equations[0].block.tex, index, index.equations[0]);
  assert.equal((rendered.match(/\\tag/g) || []).length, 1);
  assert.doesNotMatch(rendered, /\\label/);
  assert.equal(equationTex(String.raw`\\label{literal}`, index), String.raw`\\label{literal}`);
  assert.equal(equationTrust({ command: "\\href", url: "#md-equation-1" }), true);
  assert.equal(equationTrust({ command: "\\href", url: "javascript:alert(1)" }), false);
});

const dom = new JSDOM('<!doctype html><body><div id="md-content"><div id="write" contenteditable="true" tabindex="0"></div></div>', { pretendToBeVisual: true, url: "http://localhost/" });
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
window.katex = katex; window.markdownit = MarkdownIt;
window.__lettrine = { settings: {}, theme: "lettrine", file: "/tmp/equations.md" };
window.bridge = { theme: { resolve: async () => ({}) }, native: { invoke: async () => ({ text: "", data: "", mime: "text/css" }) } };
const { Editor, blockSourceFromEl } = await import("../src/renderer/editor.js");
const editor = new Editor({ root: document.getElementById("write") });
window.__lettrine.editor = editor;
const tags = (root = editor.root) => Array.from(root.querySelectorAll(".katex-html .tag"), (tag) => tag.textContent.replace(/\u200b/g, ""));
function setText(text = source, settings = {}) {
  editor.setReadOnly(false); window.__lettrine.settings = settings; editor.__settings = settings;
  editor.setText(text); editor.root.focus();
}

test("equations: display-only numbers and forward references round-trip and navigate in readonly mode", () => {
  setText();
  assert.deepEqual(tags(), ["(1)", "(A)", "(2)"]);
  assert.equal(editor.root.querySelectorAll('a[href="#md-equation-1"]').length, 1);
  assert.equal(editor.root.querySelectorAll('a[href="#md-equation-2"]').length, 1);
  assert.match(editor.root.querySelector("p").textContent, /\?\?/);
  for (let i = 0; i < editor.blocks.length; i++) assert.equal(blockSourceFromEl(editor.root.children[i]), editor.blocks[i].src);
  assert.equal(editor.root.querySelectorAll(".katex-error").length, 0);
  const history = editor._history.length;
  editor.setReadOnly(true);
  const target = editor.root.querySelector("#md-equation-1");
  let scrolled = false; target.scrollIntoView = () => { scrolled = true; };
  editor.root.querySelector('a[href="#md-equation-1"]').click();
  assert.ok(scrolled);
  assert.equal(target.__cm, undefined);
  assert.equal(editor.getMarkdown(), source);
  assert.equal(editor._history.length, history);
});

test("equations: insertion, deletion, reordering and undo update tags and references", () => {
  setText();
  const first = "$$\na=0\n$$\n\n";
  editor.replaceRange(0, 0, first);
  assert.deepEqual(tags(), ["(1)", "(2)", "(A)", "(3)"]);
  assert.equal(editor.root.querySelector('p a[href="#md-equation-2"]').textContent, "(2)");
  editor.undo(); assert.deepEqual(tags(), ["(1)", "(A)", "(2)"]); assert.equal(editor.getMarkdown(), source);
  editor.redo(); assert.deepEqual(tags(), ["(1)", "(2)", "(A)", "(3)"]);
  editor.replaceRange(0, first.length, "");
  assert.deepEqual(tags(), ["(1)", "(A)", "(2)"]);
  const moved = "$$\nz=3\\label{eq:last}\n$$\n\n" + source.slice(0, source.lastIndexOf("\n\n$$"));
  editor.replaceRange(0, editor.getMarkdown().length, moved);
  assert.deepEqual(tags(), ["(1)", "(2)", "(A)"]);
  assert.equal(editor.root.querySelector('p a[href="#md-equation-2"]').textContent, "(2)");
  assert.equal(editor.getMarkdown(), moved);
});

test("equations: settings, nested quotes, tags and image copies retain their context", () => {
  const quoted = "> $$ {#quoted}\n> q=1\n> $$\n\n" + source;
  setText(quoted);
  assert.deepEqual(tags(), ["(1)", "(2)", "(A)", "(3)"]);
  assert.equal(editor.getMarkdown(), quoted);
  const formula = editor.root.querySelectorAll(".md-math-block")[4];
  const payload = imageCopyPayload(window.__lettrine, formula);
  const copy = new JSDOM(payload.fragment).window.document;
  assert.deepEqual(tags(copy), ["(3)"]);
  window.__lettrine.settings.numberEquations = false;
  editor.renderAll({ full: true });
  assert.deepEqual(tags(), ["(A)"]);
  assert.equal(editor.getMarkdown(), quoted);
});

test("equations: HTML, unstyled MathML and Pandoc exports resolve the same tags without changing source", async () => {
  setText("> $$ {#quoted}\n> q=1\n> $$\n\n" + source);
  const text = editor.getMarkdown();
  const html = new JSDOM(await buildNativeExport({ text })).window.document;
  assert.deepEqual(tags(html), ["(1)", "(2)", "(A)", "(3)"]);
  assert.equal(html.querySelector('a[href="#md-equation-2"]').textContent, "(2)");
  assert.equal(html.querySelectorAll(".katex-error").length, 0);
  const mathml = new JSDOM(await buildNativeExport({ text, style: false })).window.document;
  assert.ok(mathml.querySelector('math [href="#md-equation-2"]'));
  const converted = equationMarkdown(text);
  assert.match(converted, /\\qquad \(\\text\{2\}\)/);
  assert.match(converted, /\\qquad \(\\text\{A\}\)/);
  assert.doesNotMatch(converted, /\\label|\\eqref|\\notag/);
  assert.equal(equationMarkdown("`\\eqref{code}`\n\n```\n$$\nx\n$$\n```"), "`\\eqref{code}`\n\n```\n$$\nx\n$$\n```");
  assert.equal(editor.getMarkdown(), text);
});
