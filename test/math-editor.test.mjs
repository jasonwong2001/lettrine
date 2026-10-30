import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM('<!doctype html><body><div id="md-content"><div id="write" contenteditable="true" tabindex="0"></div></div>', { url: "http://localhost/", pretendToBeVisual: true, runScripts: "outside-only" });
// CodeMirror measures text ranges; jsdom has no layout engine.
dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 });
dom.window.Range.prototype.getClientRects = () => [];
dom.window.focus = () => {};
for (const file of ["lib/codemirror.js", "mode/stex/stex.js"]) {
  dom.window.eval(readFileSync(new URL("../node_modules/codemirror/" + file, import.meta.url), "utf8"));
}
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
window.bridge = { path: { fileURL: (file) => "file://" + file } };
const { Editor, blockSourceFromEl } = await import("../src/renderer/editor.js");
const { handleKeydown } = await import("../src/renderer/editor-input.js");
const editor = new Editor({ root: document.getElementById("write") });
window.__lettrine = { editor, settings: {} };
after(() => { clearTimeout(editor._brushTimer); dom.window.close(); });

async function mountMath(index) {
  editor.root.focus();
  editor.placeCaret(index, 3);
  editor._syncMathFocus(index);
  await Promise.resolve();
  const node = editor.root.children[index];
  assert.ok(node.__cm, "the formula has a real CodeMirror editor");
  return node.__cm;
}

function deleteEmptyMath(cm) {
  cm.getOption("extraKeys").Backspace(cm);
}

test("math editor: deleting a newly completed formula removes its empty exit paragraph and restores undo/redo carets", async () => {
  editor.setText("$$"); editor.root.focus(); editor.placeCaret(0, 2);
  handleKeydown(editor, { key: "Enter", preventDefault() {} });
  const cm = await mountMath(0);
  const completed = "$$\n\n$$\n\n";
  assert.equal(editor.getMarkdown(), completed);
  assert.equal(editor.blocks.length, 2);
  deleteEmptyMath(cm);
  assert.equal(editor.getMarkdown(), "");
  assert.equal(editor.blocks.length, 1);
  assert.equal(document.activeElement, editor.root);
  assert.deepEqual(editor.caretInfo(), { blockIndex: 0, offset: 0 });
  editor.undo();
  assert.equal(editor.getMarkdown(), completed);
  await Promise.resolve();
  assert.deepEqual(editor.caretInfo(), { blockIndex: 0, offset: 3 });
  editor.redo();
  assert.equal(editor.getMarkdown(), "");
  assert.deepEqual(editor.caretInfo(), { blockIndex: 0, offset: 0 });
  editor.replaceSelection("after deletion");
  assert.equal(editor.getMarkdown(), "after deletion");
  assert.equal(blockSourceFromEl(editor.root.firstElementChild), "after deletion");
});

test("math editor: deleting an empty formula preserves neighboring source, DOM and trailing whitespace", async () => {
  const source = "\nBefore  \n\n\n$$\n\n$$\n\nAfter  \n\n\n";
  editor.setText(source);
  const first = editor.root.firstElementChild, after = editor.root.children[2];
  deleteEmptyMath(await mountMath(1));
  assert.equal(editor.getMarkdown(), "\nBefore  \n\n\n\n\nAfter  \n\n\n");
  assert.equal(editor.root.firstElementChild, first);
  assert.equal(editor.root.children[2], after);
  assert.deepEqual(editor.caretInfo(), { blockIndex: 1, offset: 0 });
  editor.replaceSelection("replacement");
  assert.equal(editor.getMarkdown(), source.replace("$$\n\n$$", "replacement"));
  editor.undo(); editor.undo();
  assert.equal(editor.getMarkdown(), source);
  await Promise.resolve();
  assert.deepEqual(editor.caretInfo(), { blockIndex: 1, offset: 3 });
});

test("math editor: an empty formula without a following paragraph remains editable after deletion", async () => {
  editor.setText("$$\n\n$$");
  deleteEmptyMath(await mountMath(0));
  assert.equal(editor.getMarkdown(), "");
  assert.equal(editor.blocks.length, 1);
  editor.replaceSelection("continued");
  assert.equal(editor.getMarkdown(), "continued");
  editor.undo(); editor.undo();
  assert.equal(editor.getMarkdown(), "$$\n\n$$");
});
