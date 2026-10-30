import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { parseBlocks, blocksToMarkdown, blockSeparator, inheritBlockLayout } from "../src/core/blocks.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const { Editor } = await import("../src/renderer/editor.js");

function makeEditor(text = "") {
  const root = document.createElement("div");
  root.setAttribute("contenteditable", "true");
  document.body.appendChild(root);
  const editor = new Editor({ root });
  editor.setText(text);
  return editor;
}

// Reference implementations: the uncached serialization and offset walks.
function referenceStart(blocks, index) {
  let offset = (blocks[0]?._leading || "").length;
  for (let i = 0; i < Math.min(index, blocks.length); i++) offset += (blocks[i].src || "").length + blockSeparator(blocks, i + 1).length;
  return offset;
}
function referenceOffset(blocks, off) {
  let acc = (blocks[0]?._leading || "").length;
  for (let i = 0; i < blocks.length; i++) {
    const len = (blocks[i].src || "").length;
    if (off <= acc + len) return { index: i, offset: Math.max(0, off - acc) };
    acc += len + blockSeparator(blocks, i + 1).length;
  }
  return { index: blocks.length - 1, offset: (blocks.at(-1)?.src || "").length };
}
function assertConsistent(editor, label) {
  const text = blocksToMarkdown(editor.blocks);
  assert.equal(editor.getMarkdown(), text, label + ": text");
  for (let i = 0; i <= editor.blocks.length; i++) assert.equal(editor.blockStart(i), referenceStart(editor.blocks, i), `${label}: start ${i}`);
  for (let off = 0; off <= text.length + 2; off++) assert.deepEqual(editor.globalOffsetToBlock(off), referenceOffset(editor.blocks, off), `${label}: offset ${off}`);
}
function replace(editor, index, source) {
  const next = parseBlocks(source);
  inheritBlockLayout(editor.blocks[index], next);
  editor.blocks[index] = next[0];
}

test("the cached source follows single-block edits, splices and layout changes", () => {
  const editor = makeEditor("\n\n# Title\n\npara one\n\n\n- a\n- b\n\n[^n]: note\n[^m]: more\n\n```js\nx\n```\n\n");
  assertConsistent(editor, "initial");
  const version = editor.sourceVersion();
  assert.equal(editor.sourceVersion(), version, "an unchanged model keeps its version");
  replace(editor, 1, "para one, edited");
  assertConsistent(editor, "same-type edit");
  assert.notEqual(editor.sourceVersion(), version);
  replace(editor, 1, "## now a heading");
  assertConsistent(editor, "type change");
  replace(editor, 0, "# T");
  assertConsistent(editor, "first block keeps its leading lines");
  editor.blocks.splice(2, 1);
  assertConsistent(editor, "removed block");
  editor.blocks.splice(1, 0, { type: "paragraph", src: "inserted", text: "inserted" });
  assertConsistent(editor, "inserted block without a separator");
  editor.blocks = [...editor.blocks];
  editor.blocks[editor.blocks.length - 1] = { ...editor.blocks.at(-1), _after: "\n\n\n" };
  assertConsistent(editor, "trailing lines");
});

test("adjacent footnote definitions keep their compact separator through cached edits", () => {
  const editor = makeEditor("text[^a]\n\n[^a]: one");
  editor.blocks.push({ type: "def_footnote", src: "[^b]: two", ref: "b", pattern: " ", text: "two" });
  assertConsistent(editor, "compact separator");
  replace(editor, 2, "[^b]: two, edited");
  assertConsistent(editor, "edited definition");
  replace(editor, 1, "plain paragraph");
  assertConsistent(editor, "definition became a paragraph");
});

test("randomized edits agree with the uncached serialization", () => {
  const pieces = ["alpha", "# heading", "- item\n- item two", "1. first\n- other", "> quote", "$$\nx^2\n$$", "| a | b |\n| --- | --- |\n| 1 | 2 |", "[^r]: def", "text with [^r] ref", "```\ncode\n```", "", "---"];
  let seed = 7;
  const random = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const editor = makeEditor(pieces.slice(0, 6).join("\n\n"));
  for (let step = 0; step < 3000; step++) {
    const operation = random(5), index = random(editor.blocks.length);
    if (operation <= 1) replace(editor, index, pieces[random(pieces.length)] || "x");
    else if (operation === 2) editor.blocks.splice(index, 0, ...parseBlocks(pieces[random(pieces.length)] || "y"));
    else if (operation === 3 && editor.blocks.length > 1) editor.blocks.splice(index, 1);
    else editor.blocks = editor.blocks.slice();
    assert.equal(editor.getMarkdown(), blocksToMarkdown(editor.blocks), "step " + step);
    const offset = random(editor.getMarkdown().length + 1);
    assert.deepEqual(editor.globalOffsetToBlock(offset), referenceOffset(editor.blocks, offset), "offset at step " + step);
    assert.equal(editor.blockStart(index), referenceStart(editor.blocks, index), "start at step " + step);
  }
});

test("typing patches the cached text and keeps history exact", () => {
  const editor = makeEditor(Array.from({ length: 50 }, (_, i) => "Paragraph " + i).join("\n\n"));
  editor.root.focus();
  const node = editor.root.children[25].querySelector(".md-plain").firstChild;
  for (const character of "abc") {
    node.appendData(character);
    window.getSelection().collapse(node, node.length);
    editor.handleInput({ inputType: "insertText" });
  }
  assert.equal(editor.blocks[25].src, "Paragraph 25abc");
  assert.equal(editor.getMarkdown(), blocksToMarkdown(editor.blocks));
  assert.equal(editor.globalIndexOfCaret(), editor.blockStart(25) + "Paragraph 25abc".length);
  editor.undo();
  assert.equal(editor.getMarkdown(), Array.from({ length: 50 }, (_, i) => "Paragraph " + i).join("\n\n"));
});

test("block lookups follow moved elements", () => {
  const editor = makeEditor("one\n\ntwo\n\nthree");
  const third = editor.root.children[2];
  assert.equal(editor.blockIndexOfNode(third.querySelector(".md-plain").firstChild), 2);
  editor.root.insertBefore(document.createElement("p"), editor.root.firstChild).setAttribute("mdtype", "paragraph");
  assert.equal(editor.blockIndexOfNode(third), 3);
  assert.equal(editor.blockIndexOfNode(editor.root), -1);
  assert.equal(editor.blockIndexOfNode(document.body), -1);
  const stray = document.createElement("span");
  editor.root.appendChild(stray);
  assert.equal(editor.blockIndexOfNode(stray), -1);
});
