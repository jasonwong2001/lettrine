import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import MarkdownIt from "markdown-it";
import { imageReferences, convertImageSyntax, localImagePath, imageReference, repairImageReferences, rebaseImageHistory, parseUploadConfig } from "../src/core/images.js";
import { parseBlocks, blocksToMarkdown } from "../src/core/blocks.js";
import { parseImageTag } from "../src/core/image-tag.js";

test("images: exact destination ranges include nested marks, quotes, HTML and CRLF, excluding literals", () => {
  const source = '---\r\nimage: ![metadata](skip.png)\r\n---\r\n\r\n😀 **![a](<one space.png> \'title\')**\r\n\r\n> ![b](two\\(2\\).png)\r\n> \r\n> ```md\r\n> ![literal](skip.png)\r\n> ```\r\n\r\n<img SRC="three&amp;four.png" alt="&lt;alt&gt;" onerror="bad()">\r\n\r\n`![code](skip.png)` and $![math](skip.png)$\r\n\r\n```md\r\n![fence](skip.png)\r\n```\r\n';
  const references = imageReferences(source);
  assert.deepEqual(references.map((image) => image.url), ["one space.png", "two(2).png", "three&four.png"]);
  for (const image of references) assert.equal(source.slice(image.start, image.end), image.src);
  assert.deepEqual(references.map((image) => source.slice(image.urlStart, image.urlEnd)), ["one space.png", "two\\(2\\).png", "three&amp;four.png"]);
  assert.equal(references[2].alt, "<alt>");
});

test("images: syntax conversion changes only selected images and keeps literals and alt/title content", () => {
  const source = 'Keep ![a & b](<one space.png> "a title") and ![two](two.png).\n\n`![code](code.png)`';
  const html = convertImageSyntax(source, 5, 6, "html", 50);
  assert.match(html, /<img src="one space.png" alt="a &amp; b" title="a title" style="zoom:50%;">/);
  assert.ok(html.endsWith('and ![two](two.png).\n\n`![code](code.png)`'));
  const markdown = convertImageSyntax(html, 5, 6, "markdown");
  assert.equal(markdown, source);
  assert.equal(parseImageTag('<IMG src="x.png" width="48" height="32" style="zoom:200%;position:fixed" onload="bad()">').zoom, 200);
  assert.equal(parseImageTag('<img alt="no source">'), null);
});

test("images: repaired destinations preserve Markdown spelling and use correct relative/publishing paths", () => {
  const source = '![ A ]( <images/old%23.png> \'title\' ) and <IMG alt="B" SRC=\'images/old%23.png\'>\n\n`![code](images/old%23.png)`';
  const repaired = repairImageReferences(source, "/notes/doc.md", [{ from: "/notes/images/old#.png", to: "/notes/new folder/a(b)#.png" }]);
  assert.equal(repaired, '![ A ]( <./new folder/a(b)%23.png> \'title\' ) and <IMG alt="B" SRC=\'./new folder/a(b)%23.png\'>\n\n`![code](images/old%23.png)`');
  assert.equal(localImagePath("file:///notes/a%20b%23.png", "/notes/doc.md"), "/notes/a b#.png");
  assert.equal(localImagePath("https://example.com/image.png", "/notes/doc.md"), null);
  const settings = { imageRootPath: "./static", imageRootURL: "https://images.example.com" };
  assert.equal(localImagePath("https://images.example.com/a%20b.png", "/notes/doc.md", settings), "/notes/static/a b.png");
  assert.equal(imageReference("/notes/static/new.png", "/notes/doc.md", settings), "https://images.example.com/new.png");
});

test("images: YAML/JSON upload configuration supports fields, headers and multiline commands, rejecting malformed input", () => {
  assert.deepEqual(parseUploadConfig('url: https://example.com/upload\nfileField: image\nurlPath: data.link\nheaders:\n  Authorization: "Bearer token"\nfields:\n  album: test # comment\n'), { url: "https://example.com/upload", fileField: "image", urlPath: "data.link", headers: { Authorization: "Bearer token" }, fields: { album: "test" } });
  assert.deepEqual(parseUploadConfig("command: |-\n  uploader {file}\n  echo complete\n"), { command: "uploader {file}\necho complete\n" });
  assert.deepEqual(parseUploadConfig('{"path":"/Applications/uPic.app"}'), { path: "/Applications/uPic.app" });
  for (const source of ["headers:\n bad: nope", "unknown: value", "fields: value", '{"__proto__":{}}', "command nope"]) assert.throws(() => parseUploadConfig(source));
});

const dom = new JSDOM('<!doctype html><body><div id="md-content"><div id="write" contenteditable="true" tabindex="0"></div></div>', { pretendToBeVisual: true, url: "http://localhost/" });
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
window.markdownit = MarkdownIt;
window.__lettrine = { settings: {}, file: "/notes/doc.md" };
window.bridge = {
  path: { fileURL: (file) => "file://" + file },
  theme: { resolve: async () => ({}) },
  native: { invoke: async () => ({ text: "", mime: "image/png", data: "AA==" }) },
};
const { Editor, blockSourceFromEl } = await import("../src/renderer/editor.js");
const { formatImages } = await import("../src/renderer/image-tools.js");
const { handlePaste } = await import("../src/renderer/editor-ops.js");
const { buildNativeExport } = await import("../src/renderer/native-export.js");
const editor = new Editor({ root: document.getElementById("write") }); window.__lettrine.editor = editor;
const setText = (text) => { editor.setReadOnly(false); editor.setText(text, { docBase: "/notes/doc.md" }); editor.root.focus(); };

test("images: safe HTML image rendering, source mapping, missing hints and syntax/zoom undo", () => {
  const source = '<IMG SRC="a&amp;b.png" ALT="Alt" width="48" height="32" style="zoom:50%;position:fixed" onerror="bad()">';
  setText(source);
  assert.equal(blockSourceFromEl(editor.root.firstElementChild), source);
  assert.equal(blocksToMarkdown(parseBlocks(source)), source);
  const image = editor.root.querySelector("img");
  assert.equal(image.width, 48); assert.equal(image.height, 32); assert.equal(Number(image.style.zoom), 0.5);
  assert.equal(image.getAttribute("onerror"), null); assert.equal(image.style.position, "");
  for (let offset = 0; offset <= source.length; offset++) { editor.selectOffsets(offset); assert.equal(editor.globalIndexOfCaret(), offset); }
  image.dispatchEvent(new window.Event("error"));
  assert.equal(editor.root.querySelector(".md-img-hint").textContent, "Image unavailable");
  assert.equal(blockSourceFromEl(editor.root.firstElementChild), source);
  editor.selectOffsets(0, source.length); formatImages(editor, "markdown");
  assert.equal(editor.getMarkdown(), "![Alt](a&b.png)");
  editor.undo(); assert.equal(editor.getMarkdown(), source);
  editor.redo(); editor.selectOffsets(0); formatImages(editor, "html", 200);
  assert.match(editor.getMarkdown(), /zoom:200%/);
  editor.undo(); assert.equal(editor.getMarkdown(), "![Alt](a&b.png)");
  editor.setReadOnly(true); formatImages(editor, "html"); assert.equal(editor.getMarkdown(), "![Alt](a&b.png)");
  const inline = '<img src="inline.png" alt="inline"> followed by text';
  setText(inline);
  assert.equal(editor.root.firstElementChild.getAttribute("mdtype"), "paragraph");
  assert.ok(editor.root.querySelector("img"));
  assert.equal(blockSourceFromEl(editor.root.firstElementChild), inline);
});

test("images: moved paths rebase existing undo/redo without undoing the file move", () => {
  const original = "![a](old.png)\n\nOriginal body";
  setText(original); editor.selectOffsets(original.length);
  editor.replaceSelection(" + edit");
  editor.undo();
  const transform = (text) => repairImageReferences(text, "/notes/doc.md", [{ from: "/notes/old.png", to: "/notes/images/new name.png" }]);
  rebaseImageHistory(editor, transform);
  assert.equal(editor.getMarkdown(), transform(original));
  editor.redo(); assert.equal(editor.getMarkdown(), transform(original + " + edit"));
  editor.undo(); assert.equal(editor.getMarkdown(), transform(original));
  const reverse = (text) => repairImageReferences(text, "/notes/doc.md", [{ from: "/notes/images/new name.png", to: "/notes/old.png" }]);
  rebaseImageHistory(editor, reverse);
  assert.equal(editor.getMarkdown(), "![a](./old.png)\n\nOriginal body");
  editor.redo(); assert.equal(editor.getMarkdown(), "![a](./old.png)\n\nOriginal body + edit");
});

test("images: standalone exports render sanitized HTML images with embedded assets and dimensions", async () => {
  const source = '<img src="a.png" alt="A &amp; B" width="48" style="zoom:75%;" onerror="bad()">';
  const html = await buildNativeExport({ text: source, style: false, docPath: "/notes/doc.md" });
  const exported = new JSDOM(html).window.document.querySelector("img");
  assert.ok(exported); assert.match(exported.src, /^data:image\/png;base64,/);
  assert.equal(exported.alt, "A & B"); assert.equal(exported.width, 48); assert.match(exported.getAttribute("style"), /zoom:75%/);
  assert.equal(exported.getAttribute("onerror"), null);
  assert.equal(editor.getMarkdown().includes("onerror"), false);
});

test("images: opted-in pasted uploads keep the local reference when the uploader fails", async () => {
  setText("Before "); editor.selectOffsets(7);
  let request, notice;
  window.bridge.setting = { get: async () => ({ imageUploadOnPaste: true, imageInsertDir: "inline" }) };
  window.bridge.clipboard = { readImage: async () => ({ ok: true, png: "AA==" }) };
  window.bridge.images = { import: async (payload) => { request = payload; return { reference: "./assets/local.png", uploadError: "Unavailable" }; } };
  window.__lettrineNotify = (message) => { notice = message; };
  await handlePaste(editor, { preventDefault() {}, clipboardData: { items: [{ type: "image/png" }], getData: () => "" } });
  assert.equal(request.upload, true);
  assert.equal(editor.getMarkdown(), "Before ![](./assets/local.png)");
  assert.match(notice, /local image was kept/);
  editor.undo(); assert.equal(editor.getMarkdown(), "Before ");
});
