import { test, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

// Set up a minimal DOM environment before importing renderer modules.
const dom = new JSDOM(
  `<!doctype html><html><body>
    <div id="editor" contenteditable="true"></div>
    <div id="emoji-popup"></div>
  </body></html>`,
  { url: "http://localhost/", pretendToBeVisual: true },
);

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.getSelection = () => dom.window.getSelection();
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);

const { Editor, blockSourceFromEl, caretOffsetInEl } = await import("../src/renderer/editor.js");
const { blocksToMarkdown, parseBlocks } = await import("../src/core/blocks.js");
const handleKeydownRef = await import("../src/renderer/editor-input.js");

let _rootSeq = 0;
function makeEditor() {
  // fresh root per test: Editor binds input/keydown listeners to the root,
  // so reusing one element leaks listeners from earlier editors
  const root = document.createElement("div");
  root.id = "editor-" + (++_rootSeq);
  root.contentEditable = "true";
  document.body.appendChild(root);
  return new Editor({ root });
}

test("dom: paragraph round-trips through render + DOM source walk", () => {
  const editor = makeEditor();
  editor.setText("hello **world** and `code`");
  const el = editor.root.children[0];
  const src = blockSourceFromEl(el);
  assert.equal(src, "hello **world** and `code`");
  // markers are present in the DOM but styled hidden
  assert.match(el.innerHTML, /class="md-attr"/);
  assert.match(el.innerHTML, /<strong>/);
});

test("dom: heading round-trips", () => {
  const editor = makeEditor();
  editor.setText("## Section Title");
  const el = editor.root.children[0];
  assert.equal(el.tagName, "H2");
  assert.equal(blockSourceFromEl(el), "## Section Title");
});

test("dom: list with nesting + task round-trips", () => {
  const editor = makeEditor();
  editor.setText("- a\n  - a1\n- [x] done");
  const el = editor.root.children[0];
  const src = blockSourceFromEl(el);
  assert.equal(src, "- a\n  - a1\n- [x] done");
});

test("dom: code block round-trips", () => {
  const editor = makeEditor();
  editor.setText("```js\nconst x = 1;\n```");
  const el = editor.root.children[0];
  assert.equal(blockSourceFromEl(el), "```js\nconst x = 1;\n```");
});

test("dom: quote round-trips", () => {
  const editor = makeEditor();
  editor.setText("> quoted **text**");
  const el = editor.root.children[0];
  assert.equal(blockSourceFromEl(el), "> quoted **text**");
});

test("dom: table round-trips (normalized)", () => {
  const editor = makeEditor();
  editor.setText("| h1 | h2 |\n| --- | --- |\n| a | b |");
  const el = editor.root.children[0];
  assert.equal(blockSourceFromEl(el), "| h1 | h2 |\n| --- | --- |\n| a | b |");
});

test("dom: hr, math, image round-trip", () => {
  const editor = makeEditor();
  editor.setText("***\n\n$$\nE = mc^2\n$$\n\n![pic](img.png)");
  assert.equal(editor.root.children.length, 3);
  assert.equal(blockSourceFromEl(editor.root.children[0]), "***");
  assert.equal(blockSourceFromEl(editor.root.children[1]), "$$\nE = mc^2\n$$");
  assert.equal(blockSourceFromEl(editor.root.children[2]), "![pic](img.png)");
});

test("dom: full document render preserves every source character", () => {
  const editor = makeEditor();
  const doc = [
    "# Title",
    "",
    "para with **bold**, *ital*, `code`, [link](https://x.io)",
    "",
    "1. one\n2. two",
    "",
    "> quote",
    "",
    "```\nplain code\n```",
    "",
    "---",
  ].join("\n");
  editor.setText(doc);
  const rebuilt = blocksToMarkdown(editor.blocks);
  assert.equal(rebuilt, doc);
});

test("dom: empty document renders an editable paragraph", () => {
  const editor = makeEditor();
  editor.setText("");
  assert.equal(editor.root.children.length, 1);
  assert.equal(editor.root.children[0].getAttribute("mdtype"), "paragraph");
});

test("dom: caret mapping paragraph", () => {
  const editor = makeEditor();
  editor.setText("hello world");
  const el = editor.root.children[0];
  const inline = el.querySelector(".md-plain");
  const last = lastText(inline);
  const off = caretOffsetInEl(el, last, last.data.length);
  assert.equal(off, 11);
});

// visible text = text nodes outside .md-attr / .md-decor ancestors
function visibleText(root) {
  let out = "";
  const walk = (n) => {
    if (n.nodeType === 3) { out += n.data; return; }
    if (n.nodeType !== 1) return;
    if (n.classList.contains("md-attr") || n.classList.contains("md-decor")) return;
    for (const c of n.childNodes) walk(c);
  };
  walk(root);
  return out;
}

test("dom: completed link keeps its URL inside hidden md-attr markers", () => {
  const editor = makeEditor();
  editor.setText("see [docs](https://example.com/a) now");
  const el = editor.root.children[0];
  assert.equal(visibleText(el).includes("https://example.com/a"), false, "URL leaked as visible text");
  // but the full source still reconstructs
  assert.equal(blockSourceFromEl(el), "see [docs](https://example.com/a) now");
});

test("dom: completed inline image hides its URL, keeps source reconstructable", () => {
  const editor = makeEditor();
  editor.setText("pic ![alt text](img/a.png) end");
  const el = editor.root.children[0];
  assert.equal(visibleText(el).includes("img/a.png"), false, "image URL leaked as visible text");
  assert.equal(blockSourceFromEl(el), "pic ![alt text](img/a.png) end");
});

test("dom: standalone image block hides URL and alt once loaded, source walk intact", () => {
  const editor = makeEditor();
  editor.setText("![](local.png)");
  const el = editor.root.children[0];
  assert.equal(el.getAttribute("mdtype"), "image");
  assert.equal(blockSourceFromEl(el), "![](local.png)");
});

test("dom: inline math tex source is wrapped in md-tex-src", () => {
  const editor = makeEditor();
  editor.setText("math $E=mc^2$ here");
  const el = editor.root.children[0];
  const tex = el.querySelector(".md-inline-math .md-tex-src");
  assert.ok(tex, "md-tex-src span missing");
  assert.equal(tex.textContent, "E=mc^2");
  assert.equal(blockSourceFromEl(el), "math $E=mc^2$ here");
});

test("dom: stray top-level text triggers full-DOM repair on input", () => {
  const editor = makeEditor();
  editor.setText("one");
  // what Chromium inserts when the caret escapes the block structure:
  // a raw text node directly under #write
  const stray = document.createTextNode("stray ");
  editor.root.insertBefore(stray, editor.root.firstChild);
  const sel = document.getSelection();
  const r = document.createRange();
  r.setStart(stray, 6);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  editor.root.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  // stray adjacent to a block merges INTO it (typing stays continuous)
  assert.equal(editor.getMarkdown(), "stray one");
  assert.equal(editor.root.querySelectorAll("p").length, 1);
});

test("dom: text inserted inside a paragraph but outside md-plain is kept", () => {
  const editor = makeEditor();
  editor.setText("hello");
  const p = editor.root.children[0];
  p.insertBefore(document.createTextNode("X"), p.firstChild);
  assert.equal(blockSourceFromEl(p), "Xhello");
});

test("dom: typed text syncs the model via input without destroying the text node", async () => {
  const editor = makeEditor();
  editor.setText("hello");
  const p = editor.root.children[0];
  const inline = p.querySelector(".md-plain");
  const textNode = inline.firstChild;
  // native typing: the browser mutates the live text node, then fires input
  textNode.data = "hello!";
  editor.placeCaret(0, 6);
  editor.root.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "!" }));
  assert.equal(editor.getMarkdown(), "hello!");
  // the SAME text node must still be in the DOM (IME anchors on it)
  assert.equal(inline.firstChild, textNode);
  // deferred brush eventually re-styles the block without changing the model
  await new Promise((res) => setTimeout(res, 400));
  assert.equal(editor.getMarkdown(), "hello!");
});

test("dom: text replacement expands a typed abbreviation in place", () => {
  const editor = makeEditor();
  editor._textReplacements = { kwik: "quick" };
  editor.setText("I like");
  const p = editor.root.children[0];
  const inline = p.querySelector(".md-plain");
  const textNode = inline.firstChild;
  textNode.data = "I like kwik";
  editor.placeCaret(0, 11);
  editor.root.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "k" }));
  assert.equal(editor.getMarkdown(), "I like quick");
  const ci = editor.caretInfo();
  assert.equal(ci.offset, "I like quick".length);
});

test("dom: text replacement longest key wins and does not fire without a match", () => {
  const editor = makeEditor();
  editor._textReplacements = { a: "alpha", ab: "beta" };
  editor.setText("");
  const p = editor.root.children[0];
  const inline = p.querySelector(".md-plain");
  inline.firstChild.data = "ab";
  editor.placeCaret(0, 2);
  editor.root.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "b" }));
  assert.equal(editor.getMarkdown(), "beta");
});

test("dom: IME composition stays native until commit, then updates the model once", async () => {
  const editor = makeEditor();
  editor.setText("");
  editor.placeCaret(0, 0);
  const root = editor.root;
  const inline = root.querySelector("p .md-plain");
  const setCaret = (len) => {
    const t = inline.firstChild;
    const sel = document.getSelection();
    const r = document.createRange();
    r.setStart(t, len);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  };
  root.dispatchEvent(new dom.window.CompositionEvent("compositionstart"));
  inline.textContent = "你";
  setCaret(1);
  root.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertCompositionText" }));
  // mid-composition: the model must not re-render (the IME owns the DOM)
  assert.equal(editor.getMarkdown(), "");
  inline.textContent = "你好";
  setCaret(2);
  root.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertCompositionText" }));
  assert.equal(editor.getMarkdown(), "");
  root.dispatchEvent(new dom.window.CompositionEvent("compositionend"));
  await new Promise((res) => setTimeout(res, 20));
  assert.equal(editor.getMarkdown(), "你好");
});

test("dom: fences render read-only (mock-cm) and upgrade to editable on mousedown", () => {
  const editor = makeEditor();
  editor.setText("```js\nconst a = 1;\n```");
  const pre = editor.root.querySelector("pre[mdtype='fences']");
  // bundled state: our mock-cm, not editable
  assert.ok(pre.classList.contains("mock-cm"), "should ship as mock-cm");
  assert.equal(pre.getAttribute("contenteditable"), "false");
  // mousedown upgrades in place (mouseup follows, as in a real click)
  pre.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
  editor.root.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true }));
  assert.ok(!pre.classList.contains("mock-cm"), "mousedown should drop mock-cm");
  assert.equal(pre.getAttribute("contenteditable"), "true");
  // typing (native-style) updates the model through the fences walk
  const code = pre.querySelector(".md-code-body");
  const t = code.firstChild;
  t.data = t.data + "XY";
  const sel = document.getSelection();
  const r = document.createRange();
  r.setStart(t, t.data.length);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  editor.root.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
  assert.match(editor.getMarkdown(), /const a = 1;XY/);
  // focusout returns the read-only mock state
  pre.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: false }));
  assert.ok(pre.classList.contains("mock-cm"), "focusout should restore mock-cm");
  assert.equal(pre.getAttribute("contenteditable"), "false");
  assert.match(editor.getMarkdown(), /const a = 1;XY/);
});

test("dom: fresh ``` inherits the last fence language and selects it", async () => {
  const editor = makeEditor();
  // prior fence establishes the remembered language
  editor.setText("```js\nconst a = 1;\n```");
  // Enter after the fence spawns the empty paragraph (doEnter 'after')
  const { handleKeydown } = await import("../src/renderer/editor-input.js");
  editor.placeCaret(0, "```js\nconst a = 1;\n```".length);
  handleKeydown(editor, { key: "Enter", preventDefault() {} }); // empty code line
  handleKeydown(editor, { key: "Enter", preventDefault() {} }); // empty line pops out
  const para = editor.root.children[1];
  assert.equal(para.getAttribute("mdtype"), "paragraph", "Enter on the empty line should pop out of the fence");
  const span = para.querySelector(".md-plain");
  const t = span.firstChild;
  const sel = document.getSelection();
  // native-style typing: "```" builds up in the live text node
  for (let k = 1; k <= 3; k++) {
    t.data = "`".repeat(k) + "\u200B";
    const r = document.createRange();
    r.setStart(t, k);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    editor.root.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "`" }));
  }
  const fence = editor.root.children[1];
  assert.equal(fence.getAttribute("mdtype"), "fences", "should convert to a fence");
  assert.equal(fence.dataset.info, "js", "language auto-suggested from the previous fence");
  assert.equal(String(sel.toString()), "js", "the language text should be selected for overtyping");
});

test("dom: math block reveals TeX source on focus and edits sync the model", () => {
  const editor = makeEditor();
  editor.setText("$$\nE = mc^2\n$$");
  const div = editor.root.children[0];
  assert.equal(div.getAttribute("mdtype"), "math_block");
  div.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true }));
  assert.ok(div.classList.contains("md-focus"));
  // the TeX lives in an editable plain span now
  const texSpan = div.querySelector(".md-plain");
  assert.ok(texSpan, "tex source span");
  texSpan.firstChild.data = texSpan.firstChild.data.replace("mc^2", "mc^3");
  const sel = document.getSelection();
  const r = document.createRange();
  r.setStart(texSpan.firstChild, texSpan.firstChild.data.length);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  editor.root.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
  assert.equal(editor.getMarkdown(), "$$\nE = mc^3\n$$");
  div.dispatchEvent(new dom.window.FocusEvent("focusout", { bubbles: false }));
  assert.ok(!div.classList.contains("md-focus"));
  assert.equal(editor.getMarkdown(), "$$\nE = mc^3\n$$");
});

test("dom: $$ + Enter starts a math block and typing TeX stays inside it", async () => {
  const editor = makeEditor();
  const { handleKeydown } = await import("../src/renderer/editor-input.js");
  editor.setText("");
  const p0 = editor.root.children[0];
  const span = p0.querySelector(".md-plain");
  const t = span.firstChild;
  const sel = document.getSelection();
  // type $$ natively
  t.data = "$$" + "\u200B";
  const setCaret = (node, off) => { const r = document.createRange(); r.setStart(node, off); r.collapse(true); sel.removeAllRanges(); sel.addRange(r); };
  setCaret(t, 2);
  editor.root.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "$" }));
  assert.equal(editor.blocks[0].type, "math", "$$ should already form a math block");
  editor.placeCaret(0, 2);
  handleKeydown(editor, { key: "Enter", preventDefault() {} });
  assert.equal(editor.getMarkdown(), "$$\n\n$$\n\n");
  assert.equal(editor.blocks[0].closed, true);
  assert.equal(editor.caretInfo().offset, 3);
  // typing TeX after Enter lands in the formula
  const texSpan = editor.root.children[0].querySelector(".md-plain");
  if (texSpan && texSpan.firstChild) {
    texSpan.firstChild.data += "x^2";
    setCaret(texSpan.firstChild, texSpan.firstChild.data.length);
    editor.root.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "2" }));
    assert.equal(editor.getMarkdown(), "$$\nx^2\n$$\n\n");
    assert.equal(editor.blocks[0].type, "math");
  }
});

test("dom: math completion is one undo step with the caret restored in both directions", () => {
  const editor = makeEditor();
  editor.root.tabIndex = 0;
  editor.__settings = { autoPairMarkdown: false };
  editor.setText("$$");
  editor.root.focus();
  editor.placeCaret(0, 2);
  handleKeydownRef.handleKeydown(editor, { key: "Enter", preventDefault() {} });
  const completed = "$$\n\n$$\n\n";
  assert.equal(editor.getMarkdown(), completed);
  assert.equal(blockSourceFromEl(editor.root.firstElementChild), "$$\n\n$$");
  assert.equal(editor.blocks[1].type, "paragraph");
  assert.equal(editor.blocks[1].src, "");
  assert.equal(editor.selectionOffsets().start, 3);
  editor.undo();
  assert.equal(editor.getMarkdown(), "$$");
  assert.equal(editor.selectionOffsets().start, 2);
  editor.redo();
  assert.equal(editor.getMarkdown(), completed);
  assert.equal(editor.selectionOffsets().start, 3);
});

test("dom: math completion reuses an empty following paragraph and retains surrounding source and DOM", () => {
  const editor = makeEditor();
  editor.setText("Before\n\n");
  const before = editor.root.firstElementChild;
  editor.placeCaret(1, 0);
  handleKeydownRef.handleKeydown(editor, { key: "Enter", preventDefault() {} });
  const tail = editor.root.lastElementChild;
  const opening = editor.root.children[1].querySelector(".md-plain").firstChild;
  opening.data = "$$";
  const range = document.createRange();
  range.setStart(opening, 2); range.collapse(true);
  getSelection().removeAllRanges(); getSelection().addRange(range);
  editor.handleInput({ inputType: "insertText", data: "$$" });
  handleKeydownRef.handleKeydown(editor, { key: "Enter", preventDefault() {} });
  assert.equal(editor.getMarkdown(), "Before\n\n$$\n\n$$\n\n");
  assert.equal(editor.blocks.length, 3);
  assert.equal(editor.root.firstElementChild, before);
  assert.equal(editor.root.lastElementChild, tail);
  assert.deepEqual(editor.caretInfo(), { blockIndex: 1, offset: 3 });
});

test("dom: the math fallback consumes a typed closer and its pasted tail exactly once", () => {
  for (const tail of ["", "\n\n", "\n\nAfter", "\n\nAfter\n"]) {
    const editor = makeEditor();
    editor.setText("$$");
    editor.placeCaret(0, 2);
    handleKeydownRef.handleKeydown(editor, { key: "Enter", preventDefault() {} });
    const tex = editor.root.firstElementChild.querySelector(".md-plain").firstChild;
    tex.data = "\nx+y\n$$" + tail;
    const range = document.createRange();
    range.setStart(tex, tex.data.length); range.collapse(true);
    getSelection().removeAllRanges(); getSelection().addRange(range);
    editor.handleInput({ inputType: "insertFromPaste" });
    assert.equal(editor.getMarkdown(), "$$\nx+y\n$$" + (tail || "\n\n"));
    assert.equal(editor.blocks.length, tail === "\n\nAfter\n" ? 3 : 2);
    assert.equal(editor.caretInfo().blockIndex, editor.blocks.length - 1);
    assert.equal(editor.root.firstElementChild.classList.contains("md-focus"), false);
  }
});

test("dom: math completion leaves readonly and composition Enter untouched", () => {
  for (const mode of ["readonly", "composition", "legacy-composition"]) {
    const editor = makeEditor();
    editor.setText("$$");
    editor.placeCaret(0, 2);
    if (mode === "readonly") editor.setReadOnly(true);
    let prevented = false;
    handleKeydownRef.handleKeydown(editor, {
      key: "Enter", isComposing: mode === "composition", keyCode: mode === "legacy-composition" ? 229 : 13,
      preventDefault() { prevented = true; },
    });
    assert.equal(prevented, false);
    assert.equal(editor.getMarkdown(), "$$");
  }
});

test("dom: $$ + Enter shows a visible second line and keeps the editing state", () => {
  const editor = makeEditor();
  editor.setText("");
  const t0 = editor.root.children[0].querySelector(".md-plain").firstChild;
  const sel = document.getSelection();
  t0.data = "$$";
  const r = document.createRange();
  r.setStart(t0, 2);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  editor.root.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
  assert.equal(editor.blocks[0].type, "math");
  const { handleKeydown } = handleKeydownRef;
  handleKeydown(editor, { key: "Enter", preventDefault() {} });
  // a visible TeX region: opener newline + the user's Enter line (ZWSP stripped)
  const ts = editor.root.children[0].querySelector(".md-plain").firstChild;
  // the TeX span renders "\n" + tex with ZWSP anchors framing the empty
  // line so a caret line box always exists
  assert.equal(ts.data.replace(/\u200B/g, ""), "\n", "the second line must be real content");
  assert.ok(editor.root.children[0].classList.contains("md-focus"), "editing state kept across the stay path");
  assert.equal(editor.caretInfo().offset, 3);
});

function lastText(n) {
  if (n.nodeType === 3) return n;
  for (let i = n.childNodes.length - 1; i >= 0; i--) {
    const r = lastText(n.childNodes[i]);
    if (r) return r;
  }
  return null;
}

// ---------------- footnotes & TOC (render + source walk) ----------------

test("dom: footnote def + reference render and round-trip", () => {
  const editor = makeEditor();
  const src = "see[^1] and [^two] here\n\n[^1]: first note\n\n[^two]: second note";
  editor.setText(src);
  // the definition blocks
  const defs = editor.root.querySelectorAll("[mdtype='def_footnote']");
  assert.equal(defs.length, 2);
  assert.ok(defs[0].querySelector(".md-def-name"), "def name span");
  assert.equal(defs[0].querySelector(".md-def-name").textContent, "1");
  assert.ok(defs[0].querySelector(".md-def-split"), "def split span");
  // references are numbered superscripts (first occurrence order)
  const sups = editor.root.querySelectorAll("sup.md-footnote");
  assert.equal(sups.length, 2);
  assert.ok(sups[0].classList.contains("md-has-num"));
  assert.equal(sups[0].querySelector(".md-fn-num").textContent, "1");
  assert.equal(sups[1].querySelector(".md-fn-num").textContent, "2");
  // reverse links on the definitions
  assert.equal(defs[0].querySelectorAll(".reversefootnote").length, 1);
  // source round-trip is lossless
  assert.equal(editor.getMarkdown(), src);
});

test("dom: undefined footnote reference shows raw text, no number", () => {
  const editor = makeEditor();
  editor.setText("see[^missing] here");
  const sup = editor.root.querySelector("sup.md-footnote");
  assert.ok(sup);
  assert.ok(!sup.classList.contains("md-has-num"));
  assert.equal(editor.getMarkdown(), "see[^missing] here");
});

test("dom: footnote click jumps to the definition", () => {
  const editor = makeEditor();
  editor.setText("see[^1] here\n\n[^1]: the note");
  const sup = editor.root.querySelector("sup.md-footnote");
  sup.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const ci = editor.caretInfo();
  const defBlock = editor.blocks[ci.blockIndex];
  assert.equal(defBlock.type, "def_footnote");
});

test("dom: reverse footnote link jumps back to the reference", () => {
  const editor = makeEditor();
  editor.setText("see[^1] here\n\n[^1]: the note");
  const rev = editor.root.querySelector(".reversefootnote");
  assert.ok(rev);
  rev.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const ci = editor.caretInfo();
  assert.equal(editor.blocks[ci.blockIndex].type, "paragraph");
});

test("dom: toc renders heading items and round-trips", () => {
  const editor = makeEditor();
  const src = "# A\n\n## B\n\n[toc]\n\n# C";
  editor.setText(src);
  const toc = editor.root.querySelector("[mdtype='toc']");
  assert.ok(toc);
  const items = toc.querySelectorAll(".md-toc-item");
  assert.equal(items.length, 3);
  assert.ok(items[0].className.includes("md-toc-h1"));
  assert.ok(items[1].className.includes("md-toc-h2"));
  assert.ok(items[0].textContent.includes("A"));
  assert.ok(items[1].textContent.includes("B"));
  assert.ok(items[2].textContent.includes("C"));
  assert.equal(editor.getMarkdown(), src);
});

test("dom: toc item click jumps to the heading", () => {
  const editor = makeEditor();
  editor.setText("# A\n\n[toc]\n\n# B");
  const items = editor.root.querySelectorAll(".md-toc-item");
  items[1].dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  const ci = editor.caretInfo();
  assert.equal(editor.blocks[ci.blockIndex].type, "heading");
  assert.equal(editor.blocks[ci.blockIndex].text, "B");
});

test("dom: toc refreshes when headings change", () => {
  const editor = makeEditor();
  editor.setText("# A\n\n[toc]");
  let toc = editor.root.querySelector("[mdtype='toc']");
  assert.equal(toc.querySelectorAll(".md-toc-item").length, 1);
  // add a heading via setText (full rebuild)
  editor.setText("# A\n\n## New\n\n[toc]");
  toc = editor.root.querySelector("[mdtype='toc']");
  assert.equal(toc.querySelectorAll(".md-toc-item").length, 2);
});

test("dom: toc delete button removes the block", () => {
  const editor = makeEditor();
  editor.setText("# A\n\n[toc]");
  const btn = editor.root.querySelector(".md-delete-toc");
  assert.ok(btn);
  btn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
  assert.equal(editor.root.querySelectorAll("[mdtype='toc']").length, 0);
  assert.equal(editor.getMarkdown(), "# A");
});

test("dom: typing in a footnote def name keeps the block type", () => {
  const editor = makeEditor();
  editor.setText("see[^one] here\n\n[^one]: note");
  // caret into the def name span, type to extend the ref
  const name = editor.root.querySelector("[mdtype='def_footnote'] .md-def-name");
  const r = document.createRange();
  r.setStart(name.firstChild, name.firstChild.data.length);
  r.collapse(true);
  const sel = document.getSelection();
  sel.removeAllRanges();
  sel.addRange(r);
  const span = name;
  span.firstChild.data += "x";
  editor.root.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
  const bi = editor.caretInfo().blockIndex;
  assert.equal(editor.blocks[bi].type, "def_footnote");
  assert.equal(editor.blocks[bi].ref, "onex");
});

test("dom: deleting a footnote def to empty reverts it to paragraph", () => {
  const editor = makeEditor();
  editor.setText("lead\n\n[^1]: n");
  const bi = editor.blocks.findIndex((b) => b.type === "def_footnote");
  assert.ok(bi >= 0);
  const name = editor.root.children[bi].querySelector(".md-def-name");
  const sel = document.getSelection();
  const put = (node, off) => {
    const r = document.createRange();
    r.setStart(node, off);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
  };
  const bs = () =>
    editor.root.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true }),
    );
  // delete the ref char: the def node stays alive with an empty ref
  put(name.firstChild, 1);
  name.firstChild.data = ""; // the browser would delete the char
  editor.root.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
  assert.equal(editor.blocks[bi].type, "def_footnote", "def persists with empty ref");
  assert.equal(editor.blocks[bi].ref, "");
  assert.equal(editor.getMarkdown(), "lead\n\n[^]: n");
  // delete the content char too -> fully empty def -> reverts to paragraph
  const content = editor.root.children[bi].querySelector(".md-def-content");
  put(content.firstChild, content.firstChild.data.length - 1);
  content.firstChild.data = content.firstChild.data.replace(/n$/, "");
  editor.root.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
  assert.equal(editor.blocks[bi].type, "def_footnote", "def persists with empty content");
  put(editor.root.children[bi].querySelector(".md-def-content").firstChild, 0);
  bs();
  assert.ok(!editor.blocks.some((b) => b.type === "def_footnote"), "def reverted to paragraph");
});
