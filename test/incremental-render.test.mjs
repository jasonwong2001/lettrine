import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

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
// Every element shows exactly its model block.
function assertRendered(editor, label) {
  assert.equal(editor.root.children.length, editor.blocks.length, label + ": element count");
  assert.equal(editor.root.childNodes.length, editor.blocks.length, label + ": no stray nodes");
  editor.blocks.forEach((block, i) => {
    const node = editor.root.children[i];
    assert.equal(node.dataset.cid, block._cid, `${label}: identity ${i}`);
    if (block.type !== "code" && block.type !== "math") assert.equal(blockSourceFromEl(node), block.src, `${label}: source ${i}`);
  });
  assert.equal(new Set(editor.blocks.map((block) => block._cid)).size, editor.blocks.length, label + ": unique identities");
}

test("Enter renders only the split block and keeps every other element", () => {
  const editor = makeEditor("# Title\n\nfirst paragraph\n\n$$\nx^2\n$$\n\nlast paragraph");
  const before = [...editor.root.children];
  editor.placeCaret(1, 5);
  handleKeydown(editor, { key: "Enter", preventDefault() {} });
  assert.deepEqual(editor.blocks.map((block) => block.src), ["# Title", "first", " paragraph", "$$\nx^2\n$$", "last paragraph"]);
  assert.equal(editor.root.children[0], before[0]);
  assert.equal(editor.root.children[3], before[2], "the formula keeps its rendered element");
  assert.equal(editor.root.children[4], before[3]);
  assertRendered(editor, "after Enter");
});

test("undo and redo keep unchanged elements and restore changed ones", () => {
  const source = Array.from({ length: 20 }, (_, i) => "Paragraph " + i).join("\n\n") + "\n\n```js\nconst a = 1;\n```";
  const editor = makeEditor(source);
  const before = [...editor.root.children];
  editor.replaceRange(editor.blockStart(10), editor.blockStart(10) + "Paragraph 10".length, "Changed **text**");
  assertRendered(editor, "after replace");
  assert.equal(editor.root.children[9], before[9]);
  assert.equal(editor.root.children[20], before[20], "the code block keeps its element");
  editor.undo();
  assert.equal(editor.getMarkdown(), source);
  assertRendered(editor, "after undo");
  assert.equal(editor.root.children[0], before[0]);
  assert.equal(editor.root.children[19], before[19]);
  editor.redo();
  assertRendered(editor, "after redo");
  assert.equal(editor.root.children[10].querySelector("strong")?.textContent, "**text**");
});

test("a block edited in place is rendered again when undo restores its source", () => {
  const editor = makeEditor("```js\nconst a = 1;\n```");
  const field = editor.root.querySelector(".md-lang-input");
  field.value = "python";
  field.dispatchEvent(new window.Event("change"));
  assert.equal(editor.getMarkdown(), "```python\nconst a = 1;\n```");
  editor.undo();
  assert.equal(editor.getMarkdown(), "```js\nconst a = 1;\n```");
  assert.equal(blockSourceFromEl(editor.root.children[0]), "```js\nconst a = 1;\n```");
});

test("stray nodes and rendering options rebuild every block", () => {
  const editor = makeEditor("one\n\ntwo");
  const first = editor.root.children[0];
  editor.root.appendChild(document.createTextNode("stray"));
  editor.renderAll();
  assertRendered(editor, "stray text");
  assert.notEqual(editor.root.children[0], first);
  const second = editor.root.children[1];
  editor.renderAll({ full: true });
  assert.notEqual(editor.root.children[1], second);
  assertRendered(editor, "full");
});

test("pending typing is rendered again before a structural edit keeps it", () => {
  const editor = makeEditor("alpha\n\nbeta\n\ngamma");
  const node = editor.root.children[0].querySelector(".md-plain").firstChild;
  node.appendData(" **bold**");
  window.getSelection().collapse(node, node.length);
  editor.handleInput({ inputType: "insertText" });
  assert.equal(editor.root.children[0].querySelector("strong"), null, "styling waits for the brush");
  editor.placeCaret(2, 5);
  handleKeydown(editor, { key: "Enter", preventDefault() {} });
  assert.equal(editor.root.children[0].querySelector("strong")?.textContent, "**bold**");
  assertRendered(editor, "after Enter");
});

test("randomized edits, undo and redo keep the DOM equal to the model", () => {
  const snippets = ["word", "**bold**", "\n\n# Head\n\n", "\n\n- a\n- b\n\n", "\n\n> quote\n\n", "\n\n", "`x`", "[^n]", "\n\n[^n]: note\n\n", "\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n", ""];
  let seed = 11;
  const random = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const editor = makeEditor(Array.from({ length: 12 }, (_, i) => "Paragraph " + i + " text").join("\n\n"));
  for (let step = 0; step < 150; step++) {
    const choice = random(6), text = editor.getMarkdown();
    if (choice === 0) editor.undo();
    else if (choice === 1) editor.redo();
    else if (choice === 2 && editor.blocks.length > 1) {
      editor.placeCaret(random(editor.blocks.length), 0);
      handleKeydown(editor, { key: "Backspace", preventDefault() {} });
    } else {
      const start = random(text.length + 1), end = Math.min(text.length, start + random(12));
      editor.replaceRange(start, end, snippets[random(snippets.length)]);
    }
    assertRendered(editor, "step " + step);
  }
  // A fresh render of the final model matches what the edits left behind.
  const sources = [...editor.root.children].map((node) => node.innerHTML);
  editor.renderAll({ full: true });
  assert.deepEqual([...editor.root.children].map((node) => node.innerHTML.replace(/ cid="[^"]*"| data-cid="[^"]*"/g, "")), sources.map((html) => html.replace(/ cid="[^"]*"| data-cid="[^"]*"/g, "")));
});
