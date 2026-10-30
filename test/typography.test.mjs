import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import MarkdownIt from "markdown-it";
import katex from "katex";
import { smartPunctuation, punctuationInputEdit } from "../src/core/typography.js";
import { typographicMarkdown } from "../src/core/typography-markdown.js";
import { buildNativeExport } from "../src/renderer/native-export.js";
import { imageCopyPayload } from "../src/renderer/copy-image.js";

const settings = { smartQuotes: true, smartDashes: true, smartEllipses: true, smartPunctuationMode: "render" };
test("typography: independent switches, quote context, apostrophes and CJK", () => {
  const source = `"Hello," she said. It's -- fine...`;
  assert.equal(smartPunctuation(source, settings), "\u201cHello,\u201d she said. It\u2019s \u2013 fine\u2026");
  assert.equal(smartPunctuation('他说"你好"，再说"再见"。', settings), "他说\u201c你好\u201d，再说\u201c再见\u201d。");
  assert.equal(smartPunctuation('他说："你好"。', settings), "他说：\u201c你好\u201d。");
  assert.equal(smartPunctuation("'quoted' and don't; '90s, 'tis", settings), "\u2018quoted\u2019 and don\u2019t; \u201990s, \u2019tis");
  assert.equal(smartPunctuation('"a" -- --- ...', { smartDashes: true }), '"a" \u2013 \u2014 ...');
  assert.equal(smartPunctuation(source, {}), source);
  assert.equal(smartPunctuation(String.raw`\"literal\" \-- \...`, settings), String.raw`\"literal\" \-- \...`);
});

test("typography: Pandoc conversion retains Markdown structure, literals, whitespace and link destinations", () => {
  const source = `\n# "Title"\n\nSetext "title"\n---\n\n  > "Quote"...\n  >\n  > \`\`\`js\n  > const x="--...";\n  > \`\`\`\n\n| "Head" | Value |\n| :--- | ---: |\n| **"Yes"** | -- |\n\n[Link "text"](https://example.com/a--b "Literal title") and \`"--"\` with $x--y$.\n\n\`\`\`js\nconst x="--...";\n\`\`\`\n\n$$\nx--y\n$$\n\n---\n`;
  const result = typographicMarkdown(source, settings);
  assert.match(result, /# \u201cTitle\u201d/);
  assert.match(result, /Setext \u201ctitle\u201d\n---/);
  assert.match(result, / {2}> \u201cQuote\u201d\u2026/);
  assert.match(result, /\| :--- \| ---: \|/);
  assert.match(result, /\*\*\u201cYes\u201d\*\*/);
  assert.match(result, /https:\/\/example.com\/a--b "Literal title"/);
  assert.match(result, /`"--"` with \$x--y\$/);
  assert.match(result, /const x="--\.\.\.";/);
  assert.match(result, /\$\$\nx--y\n\$\$/);
  assert.ok(result.startsWith("\n") && result.endsWith("\n\n---\n"));
  assert.equal(typographicMarkdown(source, { ...settings, smartPunctuationMode: "input" }), source);
  assert.equal(typographicMarkdown('Text[^note--].\n\n[^note--]: "Body"...', settings), 'Text[^note--].\n\n[^note--]: \u201cBody\u201d\u2026');
});

test("typography: input changes only new punctuation, protects escaped syntax, and supports a third dash", () => {
  const input = { ...settings, smartPunctuationMode: "input" };
  assert.deepEqual(punctuationInputEdit("word--", 6, input), { start: 4, end: 6, text: "\u2013" });
  assert.deepEqual(punctuationInputEdit("word\u2013-", 6, input), { start: 4, end: 6, text: "\u2014" });
  assert.deepEqual(punctuationInputEdit("word...", 7, input), { start: 4, end: 7, text: "\u2026" });
  assert.equal(punctuationInputEdit("---", 3, input), null);
  assert.equal(punctuationInputEdit(String.raw`word\--`, 7, input), null);
  assert.equal(punctuationInputEdit(String.raw`\"`, 2, input), null);
  assert.equal(punctuationInputEdit("word--", 6, settings), null);
  for (const text of ['[label](https://example.com "--', '<!--', '`code--', '$x--']) assert.equal(punctuationInputEdit(text, text.length, input), null, text);
});

const dom = new JSDOM('<!doctype html><body><div id="md-content"><div id="write" contenteditable="true" tabindex="0"></div></div>', { pretendToBeVisual: true, url: "http://localhost/" });
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
window.markdownit = MarkdownIt; window.katex = katex;
window.__lettrine = { settings, theme: "lettrine", file: "/tmp/typography.md" };
window.bridge = {
  theme: { resolve: async () => ({}) },
  native: { invoke: async () => ({ text: "", mime: "text/css", data: "" }) },
};
const { Editor, blockSourceFromEl } = await import("../src/renderer/editor.js");
const editor = new Editor({ root: document.getElementById("write") });
window.__lettrine.editor = editor;
function setText(source, options = settings) {
  editor.setReadOnly(false); editor.__settings = options; window.__lettrine.settings = options;
  editor.setText(source); editor.root.focus();
}
function renderedText(root) {
  const copy = root.cloneNode(true);
  for (const node of copy.querySelectorAll(".md-attr")) node.remove();
  return copy.textContent;
}

test("typography: display replacements round-trip every source character across block types", () => {
  const source = '# "Title"\n\nHe said **"yes"** -- <u>"now"</u>...\n\n> "Quote"\n\n- "List"\n\n| "Header" |\n| --- |\n| "Cell" |\n\n`"--..."` and $x--y$.';
  setText(source);
  assert.match(renderedText(editor.root), /\u201cTitle\u201d/);
  assert.match(renderedText(editor.root), /\u2013/);
  for (let i = 0; i < editor.blocks.length; i++) assert.equal(blockSourceFromEl(editor.root.children[i]), editor.blocks[i].src);
  assert.equal(editor.getMarkdown(), source);
  assert.equal(editor.root.querySelector("code").textContent, '`"--..."`');
  editor.setReadOnly(true);
  assert.equal(editor.getMarkdown(), source);
  assert.equal(editor.root.querySelector(".md-smart-editing"), null);
});

test("typography: caret offsets can enter and leave all source punctuation without losing positions", () => {
  const source = 'He said "yes" -- wait...';
  setText(source);
  for (let i = 0; i <= source.length; i++) {
    editor.selectOffsets(i);
    assert.equal(editor.selectionOffsets().start, i, "source offset " + i);
  }
  editor.selectOffsets(source.length - 2, source.length);
  const payload = imageCopyPayload(window.__lettrine);
  const image = new JSDOM(payload.fragment).window.document;
  assert.equal(image.body.textContent.replace(/\u200b/g, ""), "\u2026");
  assert.equal(image.querySelector(".md-smart-editing, .md-attr"), null);
  assert.equal(editor.getMarkdown(), source);
});

test("typography: input conversion has its own undo step and skips code", () => {
  const input = { ...settings, smartPunctuationMode: "input" };
  setText("word--", input); editor.selectOffsets(6);
  assert.equal(editor.applySmartPunctuation(), true); assert.equal(editor.getMarkdown(), "word\u2013");
  editor.undo(); assert.equal(editor.getMarkdown(), "word--");
  editor.redo(); assert.equal(editor.getMarkdown(), "word\u2013");
  setText('`"--..."`', input); editor.selectOffsets(3);
  assert.equal(editor.applySmartPunctuation(), false); assert.equal(editor.getMarkdown(), '`"--..."`');
});

test("typography: standalone HTML follows the switches while preserving code, math and escaped quotes", async () => {
  const source = String.raw`"Hello" **"bold"** -- ... \"literal\" ` + '`"--..."` and $x--y$.';
  const html = await buildNativeExport({ text: source, settings });
  const document = new JSDOM(html).window.document;
  assert.match(document.querySelector("p").textContent, /\u201cHello\u201d/);
  assert.equal(document.querySelector("strong").textContent, "\u201cbold\u201d");
  assert.equal(document.querySelector("code").textContent, '"--..."');
  assert.match(document.querySelector("p").textContent, /"literal"/);
  assert.ok(document.querySelector(".katex"));
  const raw = await buildNativeExport({ text: '"Hello" -- ...', settings: { ...settings, smartPunctuationMode: "input" } });
  assert.equal(new JSDOM(raw).window.document.querySelector("p").textContent, '"Hello" -- ...');
});
