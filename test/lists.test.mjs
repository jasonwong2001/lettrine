import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { parseBlocks, blocksToMarkdown, splitBlock, joinWithPrev, locateOffset, listSrcFromItems } from "../src/core/blocks.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const { Editor, blockSourceFromEl } = await import("../src/renderer/editor.js");
const { handleKeydown } = await import("../src/renderer/editor-input.js");

function makeEditor(text = "") {
  const root = document.createElement("div");
  root.setAttribute("contenteditable", "true");
  document.body.appendChild(root);
  const editor = new Editor({ root });
  editor.setText(text);
  editor.focus();
  return editor;
}
const key = (editor, name, extra = {}) => handleKeydown(editor, { key: name, preventDefault() {}, stopPropagation() {}, ...extra });
const lists = (blocks) => blocks.map((block) => block.type === "list" ? (block.ordered ? "ol:" : "ul:") + block.src : block.type + ":" + block.src);
// The document as the editor shows it: each list element and its items.
const shown = (root) => [...root.children].map((node) => node.tagName.toLowerCase() + (node.getAttribute("start") ? "@" + node.getAttribute("start") : "") + "(" + [...node.children].filter((li) => li.tagName === "LI").length + ")");

test("a different marker type starts a new list", () => {
  const cases = [
    ["- a\n- b\n1. c\n2. d", ["ul:- a\n- b", "ol:1. c\n2. d"], ["\n"]],
    ["- a\n\n1. b", ["ul:- a", "ol:1. b"], ["\n\n"]],
    ["- a\n* b", ["ul:- a", "ul:* b"], ["\n"]],
    ["1. a\n1) b", ["ol:1. a", "ol:1) b"], ["\n"]],
    ["3. a\n4. b\n- c\n\ntext", ["ol:3. a\n4. b", "ul:- c", "paragraph:text"], ["\n", "\n\n"]],
  ];
  for (const [source, expected, separators] of cases) {
    const blocks = parseBlocks(source);
    assert.deepEqual(lists(blocks), expected, source);
    assert.deepEqual(blocks.slice(1).map((block) => block._before), separators, source + ": separators");
    assert.equal(blocksToMarkdown(blocks), source, source + ": round trip");
  }
});

test("items of the same type stay in one list across blank lines and nesting", () => {
  for (const source of ["- a\n\n- b", "- a\n  1. x\n  - y\n- b", "1. a\n\n   - n\n\n2. b", "- [x] done\n- [ ] todo"]) {
    const blocks = parseBlocks(source);
    assert.equal(blocks.length, 1, source);
    assert.equal(blocks[0].src, source);
  }
});

test("loose list source and caret offsets survive rendering, typing and undo", () => {
  for (const source of ["- a\n\n- b", "- a\n \n\t\n- b", "1. a\n\n   - n\n \n2. b", "- [x] a\n\n  - nested\n\n- [ ] b"]) {
    const editor = makeEditor(source);
    assert.equal(listSrcFromItems(editor.blocks[0].items), source);
    assert.equal(blockSourceFromEl(editor.root.firstChild), source);
    for (const match of source.matchAll(/[abn](?=\n|$)/g)) {
      editor.placeCaret(0, match.index + 1);
      assert.equal(editor.caretInfo().offset, match.index + 1, source);
    }
    editor.placeCaret(0, source.length);
    const selection = window.getSelection(), node = selection.anchorNode;
    node.insertData(selection.anchorOffset, "x");
    selection.collapse(node, selection.anchorOffset + 1);
    editor.handleInput({ inputType: "insertText" });
    assert.equal(editor.getMarkdown(), source + "x");
    editor.undo();
    assert.equal(editor.getMarkdown(), source);
    editor.redo();
    assert.equal(blockSourceFromEl(editor.root.firstChild), source + "x");
  }
});

test("Enter, indentation and task toggles retain loose list gaps", () => {
  const editor = makeEditor("- a\n\n- bee");
  editor.placeCaret(0, 8);
  key(editor, "Enter");
  assert.equal(editor.getMarkdown(), "- a\n\n- b\n- ee");
  assert.equal(editor.caretInfo().offset, 11);
  editor.undo();
  editor.placeCaret(0, 10);
  key(editor, "Tab");
  assert.equal(editor.getMarkdown(), "- a\n\n  - bee");
  editor.undo();
  editor.setText("- [ ] a\n \n- [x] b");
  const checkbox = editor.root.querySelector("input");
  checkbox.checked = true;
  checkbox.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert.equal(editor.getMarkdown(), "- [x] a\n \n- [x] b");
});

test("a blank line before a list that does not continue stays between blocks", () => {
  const blocks = parseBlocks("  - a\n\n- b");
  assert.deepEqual(blocks.map((block) => block.src), ["  - a", "- b"]);
  assert.equal(blocks[1]._before, "\n\n");
});

test("joining lists of different types gives the joined items the first type", () => {
  const [bullets, numbers] = parseBlocks("- a\n- b\n\n1. c\n   - nested\n2. d");
  const joined = joinWithPrev(bullets, numbers).prev;
  assert.equal(joined.src, "- a\n- b\n- c\n   - nested\n- d");
  assert.equal(parseBlocks(joined.src).length, 1);
  const [ordered, after] = parseBlocks("1. a\n2. b\n\n* [ ] c\n* d");
  assert.equal(joinWithPrev(ordered, after).prev.src, "1. a\n2. b\n3. [ ] c\n4. d");
  const [same, other] = parseBlocks("- a\n\n- b");
  assert.equal(same.src, "- a\n\n- b", "a single list");
  assert.equal(other, undefined);
});

test("Enter on an empty nested item of another type outdents it into a list of its own", () => {
  const [list] = parseBlocks("- a\n  1. ");
  const result = splitBlock(list, list.src.length);
  assert.equal(result.kind, "replace");
  assert.deepEqual(lists(result.blocks), ["ul:- a", "ol:1. "]);
  assert.equal(result.blocks[1]._before, "\n");
  assert.deepEqual([result.caretBlock, result.offset], [1, 3]);
  const [same] = parseBlocks("- a\n  - ");
  const stay = splitBlock(same, same.src.length);
  assert.equal(stay.kind, "stay");
  assert.equal(stay.block.src, "- a\n- ");
  assert.equal(stay.offset, 6);
});

test("locateOffset maps an offset of a parsed text to its block", () => {
  const blocks = parseBlocks("- a\n- b\n1. c");
  assert.deepEqual(locateOffset(blocks, 0), { index: 0, offset: 0 });
  assert.deepEqual(locateOffset(blocks, 7), { index: 0, offset: 7 });
  assert.deepEqual(locateOffset(blocks, 8), { index: 1, offset: 0 });
  assert.deepEqual(locateOffset(blocks, 12), { index: 1, offset: 4 });
});

test("the editor shows each marker type as its own list, counting from the first number", () => {
  const source = "- a\n- b\n3. c\n4. d\n\n1) e\n\n- f\n  1. x\n  2. y\n  - z";
  const editor = makeEditor(source);
  assert.deepEqual(shown(editor.root), ["ul(2)", "ol@3(2)", "ol(1)", "ul(1)"]);
  const nested = editor.root.children[3].querySelector("li");
  assert.deepEqual([...nested.children].filter((node) => /^(UL|OL)$/.test(node.tagName)).map((node) => node.tagName), ["OL", "UL"]);
  assert.equal(editor.getMarkdown(), source);
  editor.blocks.forEach((block, i) => assert.equal(blockSourceFromEl(editor.root.children[i]), block.src, "source walk " + i));
});

test("Shift-Tab on a nested item of another type moves it into a list of its own", () => {
  const editor = makeEditor("intro\n\n- a\n  1. b\n- c");
  // caret after "b"
  editor.placeCaret(1, "- a\n  1. b".length);
  key(editor, "Tab", { shiftKey: true });
  assert.equal(editor.getMarkdown(), "intro\n\n- a\n1. b\n- c");
  assert.deepEqual(lists(editor.blocks), ["paragraph:intro", "ul:- a", "ol:1. b", "ul:- c"]);
  assert.deepEqual(shown(editor.root), ["p(0)", "ul(1)", "ol(1)", "ul(1)"]);
  const caret = editor.caretInfo();
  assert.deepEqual([caret.blockIndex, caret.offset], [2, 4]);
  editor.undo();
  assert.equal(editor.getMarkdown(), "intro\n\n- a\n  1. b\n- c");
  assert.deepEqual(shown(editor.root), ["p(0)", "ul(2)"]);
});

test("Tab nests an item under the previous one of its list", () => {
  const editor = makeEditor("- a\n- b\n\n1. c");
  editor.placeCaret(0, "- a\n- b".length);
  key(editor, "Tab");
  assert.equal(editor.getMarkdown(), "- a\n  - b\n\n1. c");
  editor.placeCaret(1, "1. c".length);
  key(editor, "Tab");
  assert.equal(editor.getMarkdown(), "- a\n  - b\n\n1. c", "the first item of a list has nothing to nest under");
});

test("Enter on an empty nested item keeps the following list and its separator", () => {
  const editor = makeEditor("- a\n  1. \n\n- b");
  editor.placeCaret(0, "- a\n  1. ".length);
  key(editor, "Enter");
  assert.equal(editor.getMarkdown(), "- a\n1. \n\n- b");
  assert.deepEqual(shown(editor.root), ["ul(1)", "ol(1)", "ul(1)"]);
  const caret = editor.caretInfo();
  assert.deepEqual([caret.blockIndex, caret.offset], [1, 3]);
});

test("Delete at the end of a list joins the next list in the first list's type", () => {
  const editor = makeEditor("- a\n\n1. b\n2. c");
  editor.placeCaret(0, 3);
  key(editor, "Delete");
  assert.equal(editor.getMarkdown(), "- a\n- b\n- c");
  assert.deepEqual(shown(editor.root), ["ul(3)"]);
});

test("a quote keeps adjacent blocks adjacent when it is edited", () => {
  const editor = makeEditor("> intro\n> - a\n> 1. b");
  const quote = editor.root.children[0];
  assert.deepEqual([...quote.children].map((node) => node.tagName), ["P", "UL", "OL"]);
  const text = quote.querySelector("p .md-plain")?.firstChild || quote.querySelector("p").firstChild;
  text.data = text.data.replace("intro", "intro!");
  assert.equal(blockSourceFromEl(quote), "> intro!\n> - a\n> 1. b");
});
