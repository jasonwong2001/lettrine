import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { parseBlocks, blocksToMarkdown, splitBlock } from "../src/core/blocks.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost/" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const { Editor, blockSourceFromEl } = await import("../src/renderer/editor.js");
const { handlePaste, formatBold, setHeading } = await import("../src/renderer/editor-ops.js");
const { handleKeydown } = await import("../src/renderer/editor-input.js");
const { openRecovery } = await import("../src/renderer/recovery.js");

function makeEditor(text = "") {
  const root = document.createElement("div");
  root.setAttribute("contenteditable", "true");
  document.body.appendChild(root);
  const editor = new Editor({ root });
  editor.setText(text);
  editor.focus();
  return editor;
}
function paste(editor, text) {
  handlePaste(editor, { preventDefault() {}, clipboardData: { getData: (type) => type === "text/plain" ? text : "", items: [] } });
}
function key(editor, key, extra = {}) {
  handleKeydown(editor, { key, preventDefault() {}, ...extra });
}

test("single-block formatting retains other live blocks and refreshes the TOC", () => {
  const source = "# Heading\n\n[toc]\n\nparagraph\n\n```js\nconst value = 1;\n```\n\n$$\nx^2\n$$";
  const editor = makeEditor(source);
  const heading = editor.root.children[0], code = editor.root.children[3], math = editor.root.children[4];
  editor.placeCaret(2, 3);
  setHeading(editor, 2);
  assert.equal(editor.root.children[0], heading);
  assert.equal(editor.root.children[3], code);
  assert.equal(editor.root.children[4], math);
  assert.equal(editor.root.querySelectorAll(".md-toc-item").length, 2);
  assert.equal(editor.blocks[2].type, "heading");
  editor.undo();
  assert.equal(editor.getMarkdown(), source);
  editor.redo();
  assert.equal(editor.blocks[2].src, "## paragraph");
});

test("typing a heading marker retains neighboring blocks and supports undo", () => {
  const editor = makeEditor("first\n\nlast");
  const neighbor = editor.root.children[1];
  const text = editor.root.firstElementChild.querySelector(".md-plain").firstChild;
  text.insertData(0, "# "); window.getSelection().collapse(text, 2);
  editor.handleInput({ inputType: "insertText" });
  assert.equal(editor.blocks[0].type, "heading");
  assert.equal(editor.root.children[1], neighbor);
  assert.equal(editor.caretInfo().offset, 2);
  editor.undo();
  assert.equal(editor.getMarkdown(), "first\n\nlast");
});

test("empty headings reveal their marker and anchor the caret before selectionchange", () => {
  const source = "Before\n\n", editor = makeEditor(source);
  editor.selectOffsets(source.length);
  const neighbor = editor.root.firstElementChild;
  const text = window.getSelection().anchorNode;
  text.insertData(0, "#"); window.getSelection().collapse(text, 1);
  editor.handleInput({ inputType: "insertText", data: "#" });
  const heading = editor.root.lastElementChild;
  assert.equal(heading.tagName, "H1");
  assert.ok(heading.classList.contains("md-simple-focus"));
  assert.equal(window.getSelection().anchorNode.nodeType, 3);
  assert.ok(heading.querySelector(".md-plain").contains(window.getSelection().anchorNode));
  assert.equal(editor.caretInfo().offset, 1);
  assert.equal(blockSourceFromEl(heading), "#");
  assert.equal(editor.root.firstElementChild, neighbor);
  editor.undo();
  assert.equal(editor.getMarkdown(), source);
  editor.redo();
  assert.equal(editor.caretInfo().offset, 1);
  assert.ok(editor.root.lastElementChild.classList.contains("md-simple-focus"));
});

test("empty heading caret and focus remain ready immediately after brushing and source selection", () => {
  const editor = makeEditor("## \n\nAfter");
  editor.selectOffsets(3);
  const neighbor = editor.root.lastElementChild;
  editor._brushPass([0]);
  const heading = editor.root.firstElementChild;
  assert.ok(heading.classList.contains("md-simple-focus"));
  assert.equal(window.getSelection().anchorNode.nodeType, 3);
  assert.ok(heading.querySelector(".md-plain").contains(window.getSelection().anchorNode));
  assert.equal(editor.caretInfo().offset, 3);
  assert.equal(editor.getMarkdown(), "## \n\nAfter");
  assert.equal(editor.root.lastElementChild, neighbor);
  editor.placeCaret(1, 0);
  assert.equal(heading.classList.contains("md-simple-focus"), false);
  editor.placeCaret(0, 3);
  assert.ok(heading.classList.contains("md-simple-focus"));
  editor.__settings = { autoExpandSimple: false };
  editor.selectOffsets(3);
  assert.equal(heading.classList.contains("md-simple-focus"), false);
  assert.equal(window.getSelection().anchorNode.nodeType, 3);
  assert.equal(editor.getMarkdown(), "## \n\nAfter");
});

test("heading caret offsets follow native edits inside the visible marker", () => {
  const editor = makeEditor("#");
  const marker = editor.root.firstElementChild.querySelector(".md-tag").firstChild;
  marker.insertData(1, "##");
  window.getSelection().collapse(marker, 3);
  editor.handleInput({ inputType: "insertText", data: "#" });
  assert.equal(editor.getMarkdown(), "###");
  assert.equal(editor.caretInfo().offset, 3);
  assert.deepEqual(editor.selectionOffsets(), { start: 3, end: 3, backward: false });
  editor.placeCaret(0, 3);
  assert.equal(editor.caretInfo().offset, 3);
  const text = window.getSelection().anchorNode;
  text.insertData(0, " Heading");
  window.getSelection().collapse(text, 8);
  editor.handleInput({ inputType: "insertText", data: " Heading" });
  assert.equal(editor.getMarkdown(), "### Heading");
  assert.equal(editor.caretInfo().offset, 11);
  editor._brushPass([0]);
  assert.equal(editor.root.firstElementChild.tagName, "H3");
  assert.equal(editor.caretInfo().offset, 11);
  assert.equal(editor.getMarkdown(), "### Heading");
});

test("history: the first edit undoes immediately and redo restores its caret", () => {
  const editor = makeEditor("hello");
  editor.replaceSelection(" world");
  editor.undo();
  assert.equal(editor.getMarkdown(), "hello");
  assert.equal(editor.caretInfo().offset, 5);
  editor.redo();
  assert.equal(editor.getMarkdown(), "hello world");
  assert.equal(editor.caretInfo().offset, 11);
});

test("caret identity survives brushing without becoming Markdown source", () => {
  const editor = makeEditor("one\n\nsecond **word**");
  const cid = editor.root.children[1].getAttribute("cid");
  editor.selectOffsets(7, 12);
  const selection = editor.selectionOffsets();
  editor._brushPass([0, 1]);
  assert.equal(editor.root.children[1].getAttribute("cid"), cid);
  assert.deepEqual(editor.selectionOffsets(), selection);
  assert.equal(editor.getMarkdown(), "one\n\nsecond **word**");
});

test("typing at a styled inline boundary stays outside its hidden syntax", () => {
  const editor = makeEditor("**word**");
  editor.placeCaret(0, 8);
  assert.equal(editor.caretInfo().offset, 8);
  const selection = window.getSelection(), text = selection.anchorNode;
  text.appendData(" tail");
  selection.collapse(text, text.length);
  editor.handleInput({ inputType: "insertText" });
  assert.equal(editor.getMarkdown(), "**word** tail");
  assert.equal(blockSourceFromEl(editor.root.firstElementChild), "**word** tail");
  editor._brushPass([0]); editor.placeCaret(0, 0);
  assert.equal(editor.caretInfo().offset, 0);
});

test("math: a bare opener keeps its caret on the delimiter until Enter starts multiline TeX", () => {
  const editor = makeEditor("$$"); editor.placeCaret(0, 2); editor._syncMathFocus(0);
  const block = editor.root.firstElementChild, marker = block.querySelector(".md-tag");
  assert.equal(block.classList.contains("md-math-opener"), true);
  assert.equal(window.getSelection().anchorNode, marker.firstChild);
  assert.equal(window.getSelection().anchorOffset, 2);
  assert.equal(block.querySelector(".md-mathblock-panel"), null);
  assert.equal(editor.getMarkdown(), "$$");
  key(editor, "Enter");
  assert.equal(editor.getMarkdown(), "$$\n\n$$\n\n");
  assert.equal(editor.root.firstElementChild.classList.contains("md-math-opener"), false);
  assert.equal(editor.blocks[0].tex, "");
  assert.equal(editor.caretInfo().offset, 3);
});

test("math: typing on the opener line keeps literal Markdown until a newline is entered", () => {
  const editor = makeEditor("$$"); editor.placeCaret(0, 2);
  const node = window.getSelection().anchorNode; node.appendData("x");
  window.getSelection().collapse(node, node.length);
  editor.handleInput({ inputType: "insertText", data: "x" });
  assert.equal(editor.getMarkdown(), "$$x");
  assert.equal(editor.blocks[0].type, "paragraph");
});

test("ordinary paragraph brushing retains unchanged TOC and footnote decorations", () => {
  const editor = makeEditor("# Heading\n\n[toc]\n\nsee[^a]\n\n[^a]: note\n\nordinary text");
  const toc = editor.root.querySelector(".md-toc-item");
  const reverse = editor.root.querySelector(".reversefootnote");
  const last = editor.blocks.length - 1;
  const text = editor.root.children[last].querySelector(".md-plain").firstChild;
  text.appendData(" extended");
  editor.placeCaret(last, text.length);
  editor.handleInput({ inputType: "insertText" });
  editor._brushPass([last]);
  assert.equal(editor.root.querySelector(".md-toc-item"), toc);
  assert.equal(editor.root.querySelector(".reversefootnote"), reverse);
  assert.match(editor.getMarkdown(), /ordinary text extended$/);
  editor.blocks[0] = { ...editor.blocks[0], src: "# Changed", text: "Changed" };
  editor._brushPass([0]);
  assert.equal(editor.root.querySelector(".md-toc-inner").textContent, "Changed");
});

test("editor preferences affect native bracket pairing, tabs and list continuation", () => {
  const editor = makeEditor("ab"); editor.__settings = { autoPair: true, tabSize: 4 };
  editor.selectOffsets(1);
  let prevented = false;
  editor.handleBeforeInput({ inputType: "insertText", data: "(", preventDefault() { prevented = true; } });
  assert.equal(prevented, true); assert.equal(editor.getMarkdown(), "a()b");
  editor.replaceSelection("x");
  editor.handleBeforeInput({ inputType: "insertText", data: ")", preventDefault() {} });
  assert.equal(editor.getMarkdown(), "a(x)b"); assert.equal(editor.globalIndexOfCaret(), 4);
  key(editor, "Tab"); assert.equal(editor.getMarkdown(), "a(x)    b");
  editor.setText("- a"); editor.placeCaret(0, 3); editor.__settings.smartList = false;
  key(editor, "Enter"); assert.equal(editor.getMarkdown(), "- a\n\n");
  editor.undo(); assert.equal(editor.getMarkdown(), "- a");
});

test("history: consecutive typing groups, structural edits remain separate, editing clears redo", () => {
  const editor = makeEditor();
  editor.replaceSelection("a", { inputType: "insertText" });
  editor.replaceSelection("b", { inputType: "insertText" });
  key(editor, "Enter");
  editor.replaceSelection("c", { inputType: "insertText" });
  editor.undo();
  assert.equal(editor.getMarkdown(), "ab\n\n");
  assert.equal(editor.caretInfo().blockIndex, 1);
  editor.undo();
  assert.equal(editor.getMarkdown(), "ab");
  editor.undo();
  assert.equal(editor.getMarkdown(), "");
  editor.redo();
  editor.replaceSelection("x", { inputType: "insertText" });
  editor.redo();
  assert.equal(editor.getMarkdown(), "abx");
});

test("history: opening another document resets undo and redo", () => {
  const editor = makeEditor("first");
  editor.replaceSelection(" edit");
  editor.setText("second");
  editor.undo();
  assert.equal(editor.getMarkdown(), "second");
  editor.redo();
  assert.equal(editor.getMarkdown(), "second");
});

test("history: all 200 undo steps survive eviction and redo restores each source", () => {
  const editor = makeEditor();
  const versions = [""];
  for (let i = 0; i < 205; i++) {
    editor.replaceSelection(String(i % 10)); versions.push(editor.getMarkdown());
  }
  assert.equal(editor._history.length, 201);
  for (let i = 204; i >= 5; i--) {
    editor.undo(); assert.equal(editor.getMarkdown(), versions[i]);
  }
  editor.undo(); assert.equal(editor.getMarkdown(), versions[5]);
  for (let i = 6; i <= 205; i++) {
    editor.redo(); assert.equal(editor.getMarkdown(), versions[i]);
  }
  editor.redo(); assert.equal(editor.getMarkdown(), versions[205]);
  editor.undo(); editor.undo(); editor.replaceSelection("branch");
  const branch = editor.getMarkdown(); editor.redo();
  assert.equal(editor.getMarkdown(), branch);
});

test("history: grouped middle insertions and deletions restore source and caret", () => {
  const source = "first 😀 paragraph\n\nsecond paragraph\n";
  const editor = makeEditor(source);
  editor.root.focus(); editor.selectOffsets(9);
  for (const text of ["a", "b", "c"]) editor.replaceSelection(text, { inputType: "insertText" });
  editor.undo(); assert.equal(editor.getMarkdown(), source);
  assert.equal(editor.selectionOffsets().start, 9);
  editor.redo(); assert.equal(editor.getMarkdown(), source.slice(0, 9) + "abc" + source.slice(9));
  assert.equal(editor.selectionOffsets().start, 12);
  editor.replaceRange(11, 12, "", { inputType: "deleteContentBackward" });
  editor.replaceRange(10, 11, "", { inputType: "deleteContentBackward" });
  editor.undo(); assert.equal(editor.getMarkdown(), source.slice(0, 9) + "abc" + source.slice(9));
  editor.undo(); assert.equal(editor.getMarkdown(), source);
  editor.redo(); editor.redo();
  assert.equal(editor.getMarkdown(), source.slice(0, 9) + "a" + source.slice(9));
});

test("paste: Markdown blocks, blank lines and a trailing newline survive a single paste and undo", () => {
  const editor = makeEditor();
  const source = "# Heading\n\nBody\n\n\n- Item\n- [ ] Task\n\n```js\nconst x = 1;\n```\n\n| Left | Right |\n| :--- | ---: |\n| a | b |\n";
  paste(editor, source);
  assert.equal(editor.getMarkdown(), source);
  assert.deepEqual(editor.blocks.map((b) => b.type), ["heading", "paragraph", "list", "code", "table", "paragraph"]);
  editor.undo();
  assert.equal(editor.getMarkdown(), "");
  editor.redo();
  assert.equal(editor.getMarkdown(), source);
});

test("paste: replaces a selection across blocks and keeps the suffix after all pasted lines", () => {
  const editor = makeEditor("before alpha\n\nbeta after");
  editor.selectOffsets(7, 18);
  paste(editor, "one\n\ntwo");
  assert.equal(editor.getMarkdown(), "before one\n\ntwo after");
  assert.equal(editor.globalIndexOfCaret(), "before one\n\ntwo".length);
  editor.undo();
  assert.equal(editor.getMarkdown(), "before alpha\n\nbeta after");
  assert.deepEqual(editor.selectionOffsets(), { start: 7, end: 18, backward: false });
});

test("input: replacing and deleting selections cannot leave ghost blocks in the model", () => {
  const editor = makeEditor("first\n\nsecond\n\nthird");
  editor.selectOffsets(2, 17);
  const event = new dom.window.InputEvent("beforeinput", { inputType: "insertText", data: "X", bubbles: true, cancelable: true });
  editor.root.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(editor.getMarkdown(), "fiXird");
  assert.equal(editor.root.children.length, 1);
  editor.selectOffsets(0, editor.getMarkdown().length);
  editor.root.dispatchEvent(new dom.window.InputEvent("beforeinput", { inputType: "deleteContentBackward", bubbles: true, cancelable: true }));
  assert.equal(editor.getMarkdown(), "");
  assert.equal(editor.root.children.length, 1);
});

test("brush: preserves both ends and direction of a selection", () => {
  const editor = makeEditor("alpha\n\nbeta");
  editor.selectOffsets(1, 10, true);
  editor._brushPass([0, 1]);
  assert.deepEqual(editor.selectionOffsets(), { start: 1, end: 10, backward: true });
});

test("brush: continuous native input keeps its text node until the insertion settles", () => {
  const editor = makeEditor("continue");
  const node = editor.root.querySelector(".md-plain").firstChild;
  node.data += " "; editor.selectOffsets(9);
  editor.handleInput({ inputType: "insertText" });
  editor._brushRun();
  assert.equal(editor.root.querySelector(".md-plain").firstChild, node);
  assert.equal(editor.getMarkdown(), "continue ");
  editor._lastNativeInputAt = -Infinity;
  editor._brushRun();
  assert.notEqual(editor.root.querySelector(".md-plain").firstChild, node);
  clearTimeout(editor._brushTimer); editor._brushTimer = null;
});

test("IME: committing Chinese text is one undoable edit and keeps the composition node alive", async () => {
  const editor = makeEditor("hello ");
  const node = editor.root.querySelector(".md-plain").firstChild;
  editor.root.dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true }));
  node.data += "中文";
  const range = document.createRange();
  range.setStart(node, node.data.length);
  range.collapse(true);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
  editor.root.dispatchEvent(new dom.window.InputEvent("input", { inputType: "insertCompositionText", bubbles: true }));
  assert.equal(editor.getMarkdown(), "hello ");
  editor._brushRun();
  assert.equal(editor.root.querySelector(".md-plain").firstChild, node);
  editor.root.dispatchEvent(new dom.window.CompositionEvent("compositionend", { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(editor.getMarkdown(), "hello 中文");
  editor.undo();
  assert.equal(editor.getMarkdown(), "hello ");
});

test("IME: a native commit redirected across hidden closing syntax retains its original source range", async () => {
  const editor = makeEditor("**bold** ");
  editor.selectOffsets(9);
  editor.root.dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true }));
  const strong = editor.root.querySelector("strong");
  strong.childNodes[1].data += "中文";
  strong.nextSibling.remove();
  editor.root.dispatchEvent(new dom.window.InputEvent("input", { inputType: "insertFromComposition", data: "中文", bubbles: true }));
  editor.root.dispatchEvent(new dom.window.CompositionEvent("compositionend", { data: "中文", bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(editor.getMarkdown(), "**bold** 中文");
  assert.equal(editor.selectionOffsets().start, 11);
  editor.undo();
  assert.equal(editor.getMarkdown(), "**bold** ");
  assert.equal(editor.selectionOffsets().start, 9);
});

test("history: a dialog's incidental DOM selection does not replace the draft caret", () => {
  const editor = makeEditor("saved");
  editor.replaceSelection(" draft");
  const button = document.createElement("button"); document.body.append(button); button.focus();
  editor.selectOffsets(2);
  editor.replaceRange(0, editor.getMarkdown().length, "saved");
  editor.undo();
  assert.equal(editor.getMarkdown(), "saved draft");
  assert.equal(editor.selectionOffsets().start, "saved draft".length);
});

test("recovery: restoring a snapshot retains the draft caret for undo", async () => {
  const editor = makeEditor("saved"); editor.replaceSelection(" draft");
  const bridge = window.bridge;
  window.bridge = { ...bridge, snapshots: { list: async () => [{ path: "/snapshot.md", mtimeMs: 1, size: 5 }], restore: async () => ({ text: "saved" }) } };
  try {
    await openRecovery({ file: "/draft.md", _documentId: 1, editor });
    editor.selectOffsets(2);
    document.querySelector(".recovery-versions button").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    document.querySelector('.recovery-dialog [data-action="restore"]').click();
    assert.equal(editor.getMarkdown(), "saved");
    editor.undo();
    assert.equal(editor.getMarkdown(), "saved draft");
    assert.equal(editor.selectionOffsets().start, "saved draft".length);
  } finally { window.bridge = bridge; document.querySelector(".recovery-dialog")?.remove(); }
});

test("blocks: Enter at the start inserts before, and a heading splits at the caret", () => {
  const editor = makeEditor("hello");
  editor.placeCaret(0, 0);
  key(editor, "Enter");
  assert.equal(editor.getMarkdown(), "\n\nhello");
  editor.setText("## hello world");
  editor.placeCaret(0, 8);
  key(editor, "Enter");
  assert.equal(editor.getMarkdown(), "## hello\n\n world");
});

test("blocks: setext headings split without losing the underline and demote with Backspace", () => {
  const editor = makeEditor("hello world\n====");
  editor.placeCaret(0, 5);
  key(editor, "Enter");
  assert.equal(editor.getMarkdown(), "hello\n====\n\n world");
  editor.undo();
  editor.placeCaret(0, 0);
  key(editor, "Backspace");
  assert.equal(editor.getMarkdown(), "hello world");
  assert.equal(editor.blocks[0].type, "paragraph");
});

test("lists: Enter splits item text and keeps nested and following siblings", () => {
  const editor = makeEditor("- parent\n  - abcdef\n  - sibling\n- last");
  editor.placeCaret(0, editor.blocks[0].src.indexOf("abcdef") + 3);
  key(editor, "Enter");
  assert.equal(editor.getMarkdown(), "- parent\n  - abc\n  - def\n  - sibling\n- last");
  assert.equal(editor.caretInfo().offset, editor.getMarkdown().indexOf("def"));
});

test("lists: an empty item exits to a paragraph and new tasks start unchecked", () => {
  const editor = makeEditor("- a\n- ");
  key(editor, "Enter");
  assert.equal(editor.getMarkdown(), "- a\n\n");
  assert.equal(editor.blocks.at(-1).type, "paragraph");
  const block = parseBlocks("- [x] finished")[0];
  const result = splitBlock(block, block.src.length);
  assert.equal(result.block.src, "- [x] finished\n- [ ] ");
});

test("lists: Tab indents only the current item and its subtree", () => {
  const editor = makeEditor("- first\n- second\n  - child\n    - grandchild\n- third");
  editor.placeCaret(0, editor.getMarkdown().indexOf("second") + 3);
  key(editor, "Tab");
  assert.equal(editor.getMarkdown(), "- first\n  - second\n    - child\n      - grandchild\n- third");
  key(editor, "Tab", { shiftKey: true });
  assert.equal(editor.getMarkdown(), "- first\n- second\n  - child\n    - grandchild\n- third");
});

test("tasks: clicking a checkbox changes Markdown and can be undone", () => {
  const editor = makeEditor("- [ ] task");
  editor.root.querySelector("input").click();
  assert.equal(editor.getMarkdown(), "- [x] task");
  editor.undo();
  assert.equal(editor.getMarkdown(), "- [ ] task");
  assert.equal(editor.root.querySelector("input").checked, false);
});

test("tables: preserve alignment, escaped pipes, spacing and every cell's source offset", () => {
  const source = "name| value\n:---|---:\n a\\|b | `x|y` ";
  const editor = makeEditor(source);
  const table = editor.root.children[0];
  assert.equal(blockSourceFromEl(table), source);
  for (const cell of table.querySelectorAll("th .md-plain, tr:not(.md-sep-row) td .md-plain")) {
    const clone = cell.cloneNode(true);
    for (const marker of clone.querySelectorAll(".md-attr")) marker.remove();
    const text = clone.textContent;
    const offset = source.indexOf(text);
    if (offset < 0) continue;
    editor.placeCaret(0, offset);
    assert.equal(editor.caretInfo().offset, offset);
  }
  editor.placeCaret(0, source.indexOf("value"));
  key(editor, "Tab", { shiftKey: true });
  assert.equal(editor.caretInfo().offset, 0);
});

test("source: parsing and editing preserve existing whitespace and block spellings", () => {
  const source = "\n  #  Title  \nText\n\n\nSetext\n======\n\n>quote\n> second\n\n```` js\ncode\n`````\n\n![pic](a.png \"title\")\n\n[^ref]:  note\n[toc]  \n\n";
  assert.equal(blocksToMarkdown(parseBlocks(source)), source);
  const editor = makeEditor(source);
  assert.equal(editor.getMarkdown(), source);
  for (let i = 0; i < editor.blocks.length; i++) assert.equal(blockSourceFromEl(editor.root.children[i]), editor.blocks[i].src, editor.blocks[i].type);
  const textIndex = editor.blocks.findIndex((b) => b.src === "Text");
  editor.placeCaret(textIndex, 4);
  editor.replaceSelection("!");
  assert.equal(editor.getMarkdown(), source.replace("Text", "Text!"));
});

test("format: a selected word remains selected through formatting and undo", () => {
  const editor = makeEditor("hello world");
  editor.selectOffsets(6, 11);
  formatBold(editor);
  assert.equal(editor.getMarkdown(), "hello **world**");
  assert.equal(window.getSelection().toString(), "world");
  editor.undo();
  assert.equal(editor.getMarkdown(), "hello world");
  assert.deepEqual(editor.selectionOffsets(), { start: 6, end: 11, backward: false });
});

test("selection: Select All includes hidden heading markers and the final newline", () => {
  const editor = makeEditor("# Title\n\nlast\n");
  editor.selectOffsets(0, editor.getMarkdown().length);
  paste(editor, "replacement");
  assert.equal(editor.getMarkdown(), "replacement");
});

test("selection: Backspace/Delete remove selected atomic formulas without relying on beforeinput", () => {
  const formula = "$$\nx^2+y^2=z^2\n$$";
  for (const source of [formula, "before\n\n" + formula, formula + "\n\nafter\n"]) {
    for (const name of ["Backspace", "Delete"]) {
      const editor = makeEditor(source); editor.selectOffsets(0, source.length);
      const event = new dom.window.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
      editor.root.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true);
      assert.equal(editor.getMarkdown(), "");
      assert.equal(editor.root.firstElementChild.getAttribute("mdtype"), "paragraph");
      editor.undo(); assert.equal(editor.getMarkdown(), source);
      editor.redo(); assert.equal(editor.getMarkdown(), "");
      editor.replaceSelection("continued"); assert.equal(editor.getMarkdown(), "continued");
    }
  }
});

test("selection: forward/backward selections of a generated formula map to its entire source", () => {
  const formula = "$$\nx^2+y^2=z^2\n$$";
  for (const backward of [false, true]) {
    const editor = makeEditor("Before\n\n" + formula + "\n\nAfter");
    const preview = editor.root.querySelector(".md-math-body"); preview.textContent = "Rendered formula";
    const text = preview.firstChild, selection = window.getSelection();
    selection.setBaseAndExtent(text, backward ? text.length : 0, text, backward ? 0 : text.length);
    assert.deepEqual(editor.selectionOffsets(), { start: 8, end: 8 + formula.length, backward });
    key(editor, "Delete"); assert.equal(editor.getMarkdown(), "Before\n\n\n\nAfter");
    editor.undo(); assert.equal(editor.getMarkdown(), "Before\n\n" + formula + "\n\nAfter");
  }
});

test("images: paste writes assets beside the document and respects the selection", async () => {
  const editor = makeEditor("replace this");
  editor.docBase = "/tmp/notes.md";
  editor.selectOffsets(0, editor.getMarkdown().length);
  let savedDocument;
  window.bridge = {
    setting: { get: async () => ({ imageInsertDir: "./assets" }) },
    clipboard: { readImage: async () => ({ ok: true, png: "aGVsbG8=" }) },
    images: { import: async (p) => { savedDocument = p.docPath; return { reference: "./assets/pasted.png" }; } },
  };
  await handlePaste(editor, { preventDefault() {}, clipboardData: { items: [{ type: "image/png" }] } });
  assert.equal(savedDocument, "/tmp/notes.md");
  assert.equal(editor.getMarkdown(), "![](./assets/pasted.png)");
  editor.undo();
  assert.equal(editor.getMarkdown(), "replace this");
});

test("images: finishing an asynchronous paste cannot overwrite a different document", async () => {
  const editor = makeEditor("first");
  let finish;
  window.bridge = {
    setting: { get: () => new Promise((resolve) => { finish = resolve; }) },
    clipboard: { readImage: async () => ({ ok: true, png: "aGVsbG8=" }) },
  };
  const pending = handlePaste(editor, { preventDefault() {}, clipboardData: { items: [{ type: "image/png" }] } });
  editor.setText("another document");
  finish({ imageInsertDir: "inline" });
  await pending;
  assert.equal(editor.getMarkdown(), "another document");
});

test("math: closing before CodeMirror loads also finishes the formula and preserves following input", () => {
  const editor = makeEditor("$$\nx\n$");
  const node = editor.root.querySelector(".md-plain").firstChild;
  node.data += "$";
  const range = document.createRange();
  range.setStart(node, node.data.length);
  range.collapse(true);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
  editor.handleInput({ inputType: "insertText" });
  assert.equal(editor.blocks[0].closed, true);
  assert.equal(editor.root.children[0].classList.contains("md-focus"), false);
  assert.equal(editor.getMarkdown(), "$$\nx\n$$\n\n");
  editor.replaceSelection("after");
  assert.equal(editor.getMarkdown(), "$$\nx\n$$\n\nafter");
});
