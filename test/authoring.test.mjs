import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { parseBlocks, blocksToMarkdown } from "../src/core/blocks.js";
import { parseInline } from "../src/core/inline.js";
import { editTableRow } from "../src/core/table.js";
import { linkMarkdown } from "../src/core/links.js";
import { tocOptions } from "../src/core/toc.js";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
const { Editor, blockSourceFromEl } = await import("../src/renderer/editor.js");
const { formatLink, tableAddRow, deleteRow, moveTableRow, maybeEmojiPopup } = await import("../src/renderer/editor-ops.js");
const { handleKeydown } = await import("../src/renderer/editor-input.js");
const { showSpellSuggestions } = await import("../src/renderer/spelling.js");
function editor(text) {
  const root = document.createElement("div");
  root.setAttribute("contenteditable", "true");
  document.body.appendChild(root);
  const ed = new Editor({ root });
  ed.setText(text);
  ed.focus();
  return ed;
}
function submitLink(url, title = "") {
  document.getElementById("link-url").value = url;
  document.getElementById("link-title").value = title;
  document.querySelector("#link-dialog form").dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
}

test("table rows: insert, move and delete preserve original rows and alignment", () => {
  const source = "A|B\n:---|---:\n one | 1 \n two | 2 ";
  const block = parseBlocks(source)[0];
  const offset = source.indexOf("two");
  const moved = editTableRow(block, offset, "up");
  assert.equal(moved.source, "A|B\n:---|---:\n two | 2 \n one | 1 ");
  assert.equal(moved.source.slice(moved.offset, moved.offset + 3), "two");
  assert.equal(editTableRow(block, 0, "delete"), null);
  assert.equal(editTableRow(block, source.indexOf("one"), "delete").source, "A|B\n:---|---:\n two | 2 ");
  const ed = editor(source);
  ed.placeCaret(0, offset);
  tableAddRow(ed, true);
  assert.equal(ed.blocks[0].rows.length, 3);
  assert.equal(ed.blocks[0].sepLine, ":---|---:");
  deleteRow(ed);
  assert.equal(ed.getMarkdown(), source);
  ed.placeCaret(0, offset);
  moveTableRow(ed, -1);
  assert.equal(ed.getMarkdown(), moved.source);
  ed.undo();
  assert.equal(ed.getMarkdown(), source);
});

test("table decorations edit columns/alignment, stay out of source, and undo independently", () => {
  const source = "| A | B |\n| :--- | ---: |\n| one | two |\n| three | four |";
  const ed = editor(source);
  assert.equal(blockSourceFromEl(ed.root.firstChild), source);
  ed.root.querySelector(".app-table-add-column-after").click();
  assert.equal(ed.blocks[0].headers.length, 3);
  assert.equal(blockSourceFromEl(ed.root.firstChild), ed.getMarkdown());
  ed.undo(); assert.equal(ed.getMarkdown(), source);
  const align = ed.root.querySelector(".app-table-align-column");
  align.value = "center"; align.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  assert.match(ed.blocks[0].sepLine, /:---:/);
  ed.undo(); assert.equal(ed.getMarkdown(), source);
  ed.placeCaret(0, source.indexOf("three"));
  handleKeydown(ed, { key: "Backspace", preventDefault() {} });
  assert.equal(ed.blocks[0].rows.length, 1);
  assert.match(ed.getMarkdown(), /one three \| two four/);
  ed.undo(); assert.equal(ed.getMarkdown(), source);
});

test("spelling suggestions replace the selected word without leaking popup text into Markdown", async () => {
  const ed = editor("A mispellled word."); ed.selectOffsets(2, 12);
  globalThis.innerWidth = 1180; globalThis.innerHeight = 800;
  window.bridge = { word: { getSpellSuggestionInContext: async () => ({ misspelled: true, suggestions: ["misspelled"] }), updateDictionary: async () => ({}) } };
  await showSpellSuggestions(ed, { x: 10, y: 10 });
  const menu = document.querySelector(".md-spelling-menu"); assert.ok(menu);
  assert.equal(ed.getMarkdown(), "A mispellled word.");
  menu.querySelector("button").click();
  assert.equal(ed.getMarkdown(), "A misspelled word.");
  ed.undo(); assert.equal(ed.getMarkdown(), "A mispellled word.");
});

test("emoji completion navigates and confirms after styled text without replacing its prefix", () => {
  const popup = document.createElement("div"); popup.id = "emoji-completion"; document.body.appendChild(popup);
  const ed = editor("**bold** :smil");
  ed.placeCaret(0, ed.getMarkdown().length);
  maybeEmojiPopup(ed); assert.equal(window.__emojiPopupOpen, true);
  handleKeydown(ed, { key: "ArrowDown", preventDefault() {} });
  assert.equal(popup.children[1].classList.contains("active"), true);
  handleKeydown(ed, { key: "Escape", preventDefault() {} });
  assert.equal(window.__emojiPopupOpen, false);
  assert.ok(ed.getMarkdown().startsWith("**bold** "));
  assert.ok(!ed.getMarkdown().includes(":smil"));
  ed.undo(); assert.equal(ed.getMarkdown(), "**bold** :smil");
  maybeEmojiPopup(ed); ed.setText("different document");
  assert.equal(window.__emojiPopupOpen, false);
});

test("literal zero-width spaces survive source walks and caret mapping while empty placeholders do not", () => {
  for (const source of ["one\u200Btwo", "\u200B**bold**\u200B", "[^n]: \u200Bnote", "```text\na\u200Bb\n```", "$$\na\u200Bb\n$$"]) {
    const ed = editor(source);
    assert.equal(blockSourceFromEl(ed.root.firstChild), source);
    if (ed.blocks[0].type === "paragraph") { ed.selectOffsets(4); assert.equal(ed.globalIndexOfCaret(), 4); }
  }
  const ed = editor(""); const node = ed.root.querySelector(".md-plain").firstChild;
  node.data += "a\u200Bb";
  ed.placeCaret(0, 3); ed.handleInput({ inputType: "insertText" });
  assert.equal(ed.getMarkdown(), "a\u200Bb");
});

test("standalone images share the inline URL parser for spaces, nested brackets and balanced parentheses", () => {
  for (const source of ['![a](<assets/my image.png> "title")', '![a[b]](assets/image(one).svg)', '  ![a[b]](<my image.svg> \'title\')  ']) {
    const ed = editor(source), parsed = parseInline(source).find((part) => part.type === "image");
    assert.equal(ed.blocks[0].type, "image");
    assert.equal(ed.blocks[0].url, parsed.url);
    assert.ok(ed.root.querySelector("img"));
    assert.equal(blockSourceFromEl(ed.root.firstChild), source);
  }
});

test("inline legacy math and explicit line breaks keep their exact markers in source walks", () => {
  for (const source of [String.raw`a \(x^2\) b`, "one  \ntwo", "one\\\ntwo", "<https://example.com>"]) {
    const ed = editor(source); assert.equal(blockSourceFromEl(ed.root.firstChild), source);
    if (source.includes("\n")) assert.ok(ed.root.querySelector("br.md-decor"));
    if (source.includes("\\(")) assert.equal(parseInline(source).find((part) => part.type === "math").tex, "x^2");
  }
});

test("inline style completion respects delimiter runs, escapes and word endings", () => {
  for (const source of ["**a*", "**a**word", "*a*word", "__a__word", String.raw`**a\**`]) {
    assert.ok(!parseInline(source).some((part) => part.type === "bold" || part.type === "italic"), source);
    const ed = editor(source); assert.equal(blockSourceFromEl(ed.root.firstChild), source);
  }
  const ed = editor("***bold and italic***");
  assert.equal(ed.root.querySelector("strong em").textContent.replaceAll("*", ""), "bold and italic");
  assert.equal(blockSourceFromEl(ed.root.firstChild), "***bold and italic***");
});

test("footnotes: Tab/Shift-Tab move between name and content without changing source", () => {
  const ed = editor("[^note]: content");
  ed.placeCaret(0, 3);
  handleKeydown(ed, { key: "Tab", preventDefault() {} });
  let anchor = window.getSelection().anchorNode;
  assert.equal((anchor.nodeType === 3 ? anchor.parentElement : anchor).className, "md-def-content md-plain");
  handleKeydown(ed, { key: "Tab", shiftKey: true, preventDefault() {} });
  anchor = window.getSelection().anchorNode;
  assert.equal((anchor.nodeType === 3 ? anchor.parentElement : anchor).className, "md-def-name");
  assert.equal(ed.getMarkdown(), "[^note]: content");
  const defs = [{ type: "def_footnote", src: "[^a]: A" }, { type: "def_footnote", src: "[^b]: B" }];
  assert.equal(blocksToMarkdown(defs), "[^a]: A\n[^b]: B");
});

test("TOC attributes: supported width/depth affect layout and retain their source", () => {
  const source = '{: toc width="50%" depth=2 }\n\n# One\n\n### Three';
  const ed = editor(source);
  assert.equal(ed.root.firstChild.style.width, "50%");
  assert.equal(ed.root.querySelectorAll(".md-toc-item").length, 1);
  assert.equal(ed.getMarkdown(), source);
  assert.deepEqual(tocOptions('{: toc width="9999px" depth=9 }'), { depth: 6, width: undefined });
});

test("links: balanced destinations, spaces and titles preserve exact Markdown", () => {
  for (const source of ['[x](https://example.com/a(b))', '[file](<my notes.md> "a title")', '[x](file.md \'title\')']) {
    assert.equal(parseInline(source)[0].type, "link");
    const ed = editor(source);
    assert.equal(blockSourceFromEl(ed.root.firstChild), source);
  }
  const built = linkMarkdown("A [link]", "https://example.com/a(b)", 'say "hello"');
  const parsed = parseInline(built.source)[0];
  assert.equal(parsed.url, "https://example.com/a(b)");
  assert.equal(parsed.title, 'say "hello"');
});

test("link dialog: create, edit and remove a link with selection and undo", async () => {
  const ed = editor("hello world");
  ed.selectOffsets(6, 11);
  let pending = formatLink(ed);
  submitLink("https://example.com/a(b)", "title");
  await pending;
  const linked = ed.getMarkdown();
  assert.equal(parseInline(linked).find((part) => part.type === "link").url, "https://example.com/a(b)");
  assert.equal(window.getSelection().toString(), "world");
  pending = formatLink(ed);
  assert.equal(document.getElementById("link-url").value, "https://example.com/a(b)");
  submitLink("notes.md");
  await pending;
  assert.equal(ed.getMarkdown(), "hello [world](notes.md)");
  pending = formatLink(ed);
  document.getElementById("link-remove").click();
  await pending;
  assert.equal(ed.getMarkdown(), "hello world");
  ed.undo();
  assert.equal(ed.getMarkdown(), "hello [world](notes.md)");
});

test("link dialog: a stale dialog cannot modify a different document", async () => {
  const ed = editor("old document");
  const pending = formatLink(ed);
  ed.setText("new document");
  submitLink("https://example.com");
  await pending;
  assert.equal(ed.getMarkdown(), "new document");
});
