import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { parseBlocks, blocksToMarkdown } from "../src/core/blocks.js";
import { readableMarkdown } from "../src/core/readable.js";
import { localizeUI } from "../src/renderer/localization.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const { Editor, blockSourceFromEl } = await import("../src/renderer/editor.js");
const { handleKeydown } = await import("../src/renderer/editor-input.js");
function makeEditor(source = "") {
  const root = document.createElement("div");
  root.contentEditable = "true";
  root.setAttribute("contenteditable", "true");
  document.body.appendChild(root);
  const editor = new Editor({ root });
  editor.setText(source); editor.focus();
  return editor;
}
const key = (editor, key) => handleKeydown(editor, { key, preventDefault() {} });
function type(editor, text) {
  for (const character of text) {
    const selection = window.getSelection(), node = selection.anchorNode, offset = selection.anchorOffset;
    assert.equal(node.nodeType, 3);
    node.insertData(offset, character); selection.collapse(node, offset + character.length);
    editor.handleInput({ inputType: "insertText", data: character });
  }
}

test("YAML front matter preserves metadata and delimiters as plain source", () => {
  for (const closing of ["---", "..."]) {
    const metadata = `\uFEFF--- \ntitle: "**Title**"\n# comment\nitems:\n  - one\n\nhtml: <b>text</b>\n${closing}  `;
    const source = metadata + "\n\n# Body";
    const blocks = parseBlocks(source);
    assert.deepEqual(blocks.map((block) => block.type), ["frontmatter", "heading"]);
    assert.equal(blocks[0].src, metadata);
    assert.equal(blocks[0].closed, true);
    assert.equal(blocksToMarkdown(blocks), source);
    assert.equal(readableMarkdown(source), "Body");
    const editor = makeEditor(source);
    assert.equal(blockSourceFromEl(editor.root.firstChild), metadata);
    assert.equal(editor.root.firstChild.querySelector("strong, ul, h1"), null);
    assert.deepEqual(editor.getOutline().map((item) => item.text), ["Body"]);
    editor.placeCaret(0, metadata.indexOf("Title") + 5);
    type(editor, "!");
    assert.equal(editor.getMarkdown(), source.replace("Title", "Title!"));
    editor.undo(); assert.equal(editor.getMarkdown(), source);
    editor.redo(); assert.equal(editor.getMarkdown(), source.replace("Title", "Title!"));
  }
});

test("front matter is recognized only on the actual first document line", () => {
  for (const source of ["\n---\ntitle: text\n---", "# Body\n\n---\ntitle: text\n---", "> ---\n> title: text\n> ---"]) {
    const blocks = parseBlocks(source);
    assert.ok(!blocks.some((block) => block.type === "frontmatter"));
    if (blocks[0].type === "quote") assert.ok(!blocks[0].items.some((block) => block.type === "frontmatter"));
    assert.equal(blocksToMarkdown(blocks), source);
  }
  assert.equal(parseBlocks("---\ntitle: text\n---", { documentStart: false })[0].type, "hr");
  assert.equal(parseBlocks("---\ntitle: text")[0].closed, false);
  assert.equal(parseBlocks("---")[0].type, "hr");
});

test("a typed rule stays on its visible delimiter until Enter, and continued typing survives", () => {
  for (const delimiter of ["---", "***", "___"]) {
    const editor = makeEditor("Body\n\n");
    type(editor, delimiter);
    assert.equal(editor.blocks[1].pending, true);
    assert.equal(editor.root.children[1].tagName, "P");
    assert.equal(window.getSelection().anchorNode.parentElement.className, "md-tag");
    type(editor, "text");
    assert.equal(editor.getMarkdown(), "Body\n\n" + delimiter + "text");
    editor.setText("Body\n\n"); editor.focus();
    type(editor, delimiter); key(editor, "Enter");
    assert.equal(editor.root.children[1].getAttribute("role"), "separator");
    assert.equal(editor.caretInfo().blockIndex, 2);
    type(editor, "After");
    assert.equal(editor.getMarkdown(), "Body\n\n" + delimiter + "\n\nAfter");
    editor.undo(); editor.undo();
    assert.equal(editor.getMarkdown(), "Body\n\n" + delimiter);
    assert.equal(editor.root.children[1].tagName, "P");
  }
});

test("Enter after an empty document's opening delimiter starts editable YAML and exits at its closer", () => {
  const editor = makeEditor();
  type(editor, "---"); key(editor, "Enter");
  assert.equal(editor.blocks[0].type, "frontmatter");
  assert.equal(editor.getMarkdown(), "---\n");
  assert.equal(editor.caretInfo().offset, 4);
  const panel = editor.root.firstChild, caption = panel.querySelector(".md-frontmatter-caption");
  assert.ok(panel.classList.contains("md-frontmatter"));
  assert.equal(caption.getAttribute("contenteditable"), "false");
  assert.equal(caption.querySelector(".md-frontmatter-label").textContent, "YAML Front Matter");
  assert.equal(caption.querySelector(".md-frontmatter-hint").id, panel.getAttribute("aria-describedby"));
  assert.ok(caption.classList.contains("md-decor"));
  assert.ok(panel.querySelector(".md-plain").contains(window.getSelection().anchorNode));
  type(editor, "title: Example"); key(editor, "Enter");
  type(editor, "---");
  assert.equal(editor.blocks[0].closed, true);
  editor._brushPass([0]);
  assert.equal(editor.root.firstChild.querySelector(".md-frontmatter-hint"), null);
  assert.equal(editor.root.firstChild.getAttribute("aria-describedby"), null);
  assert.equal(editor.caretInfo().offset, editor.blocks[0].src.length);
  key(editor, "Enter"); type(editor, "Body");
  assert.equal(editor.getMarkdown(), "---\ntitle: Example\n---\n\nBody");
  assert.equal(editor.blocks[1].type, "paragraph");
  editor.undo(); editor.undo();
  assert.equal(editor.getMarkdown(), "---\ntitle: Example\n---");
  editor.redo(); editor.redo();
  assert.equal(editor.getMarkdown(), "---\ntitle: Example\n---\n\nBody");
});

test("front matter labels stay outside source and caret offsets across locale changes", () => {
  const metadata = "---\ntitle: Settings\n# comment\nitems:\n  - one\n---";
  const source = metadata + "\n\nSettings";
  const editor = makeEditor(source);
  const translations = JSON.parse(readFileSync(new URL("../src/locales/zh-Hans.json", import.meta.url), "utf8"));
  try {
    localizeUI({ locale: "zh-Hans", strings: translations });
    assert.equal(editor.root.querySelector(".md-frontmatter-label").textContent, translations["YAML Front Matter"]);
    assert.equal(blockSourceFromEl(editor.root.firstChild), metadata);
    assert.equal(editor.getMarkdown(), source);
    assert.equal(editor.root.lastChild.textContent, "Settings");
    for (let offset = 0; offset <= metadata.length; offset++) {
      editor.placeCaret(0, offset);
      assert.equal(editor.caretInfo().offset, offset);
      assert.ok(editor.root.firstChild.querySelector(".md-plain").contains(window.getSelection().anchorNode));
    }
    editor.setText("---\n");
    assert.equal(editor.root.querySelector(".md-frontmatter-hint").textContent, translations["End with --- on a new line, then press Return."]);
    assert.equal(blockSourceFromEl(editor.root.firstChild), "---\n");
    localizeUI({ locale: "en", strings: {} });
    assert.equal(editor.root.querySelector(".md-frontmatter-label").textContent, "YAML Front Matter");
    assert.equal(editor.getMarkdown(), "---\n");
  } finally {
    localizeUI({ locale: "en", strings: {} });
  }
});

test("clicking the front matter caption places typing in the metadata source", () => {
  const source = "---\ntitle: Example\n---\n\nBody";
  const editor = makeEditor(source);
  editor.placeCaret(1, 4);
  const event = new window.MouseEvent("mousedown", { bubbles: true, cancelable: true });
  editor.root.querySelector(".md-frontmatter-label").dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(editor.caretInfo().blockIndex, 0);
  assert.equal(editor.caretInfo().offset, 4);
  type(editor, "x");
  assert.equal(editor.getMarkdown(), source.replace("title:", "xtitle:"));
  editor.undo(); assert.equal(editor.getMarkdown(), source);
});

test("selecting a document with front matter starts in editable source and preserves every character", () => {
  for (const source of [
    "---\n",
    "---\ntitle: Example\n---",
    "---\ntitle: Example\n---\n\n# Heading\n\nBody\n",
    "\uFEFF--- \ntitle: Example\n...  \n\nBody\n",
  ]) {
    for (const backward of [false, true]) {
      const editor = makeEditor(source);
      editor.selectOffsets(0, source.length, backward);
      const selection = window.getSelection(), range = selection.getRangeAt(0);
      assert.ok(editor.root.firstChild.querySelector(".md-plain").contains(range.startContainer));
      assert.equal(selection.toString().includes("YAML Front Matter"), false);
      const offsets = editor.selectionOffsets();
      assert.deepEqual(offsets, { start: 0, end: source.length, backward });
      assert.equal(editor.getMarkdown().slice(offsets.start, offsets.end), source);
      assert.equal(editor.deleteSelection(), true);
      assert.equal(editor.getMarkdown(), "");
      editor.undo(); assert.equal(editor.getMarkdown(), source);
      editor.redo(); assert.equal(editor.getMarkdown(), "");
    }
  }
});

test("editing a metadata delimiter reparses the affected document boundary", () => {
  const source = "---\ntitle: Example\n---\n\n# Body";
  const editor = makeEditor(source);
  editor.placeCaret(0, editor.blocks[0].src.length);
  const node = window.getSelection().anchorNode;
  const at = window.getSelection().anchorOffset;
  node.deleteData(at - 1, 1); window.getSelection().collapse(node, at - 1);
  editor.handleInput({ inputType: "deleteContentBackward" });
  assert.equal(editor.blocks.length, 1);
  assert.equal(editor.blocks[0].closed, false);
  assert.equal(editor.getMarkdown(), source.replace("\n---\n", "\n--\n"));
  editor.undo(); assert.equal(editor.getMarkdown(), source);
  assert.equal(editor.blocks[1].type, "heading");
  editor.setText(source.replace("Example", "Updated"), { resetHistory: false });
  assert.equal(editor.blocks[0].body, "title: Updated");
  editor.setText(source); editor.placeCaret(0, 0);
  key(editor, "Enter");
  assert.equal(editor.getMarkdown(), "\n" + source);
  assert.ok(!editor.blocks.some((block) => block.type === "frontmatter"));
  editor.setText(source);
  const offset = editor.blocks[0].src.length - 1;
  editor.placeCaret(0, offset);
  editor._insertTextAtCaret("x");
  assert.equal(editor.blocks.length, 1);
  assert.equal(editor.globalIndexOfCaret(), offset + 1);
  editor.undo(); assert.equal(editor.getMarkdown(), source);
  editor.redo(); assert.equal(editor.globalIndexOfCaret(), offset + 1);
});
