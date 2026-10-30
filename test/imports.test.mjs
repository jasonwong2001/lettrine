import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { IMPORT_FORMATS, importFormat, importDefaultPath } from "../src/core/imports.js";

test("imports: supported formats and destination names are explicit and source-safe", () => {
  for (const [extension, reader] of Object.entries(IMPORT_FORMATS)) assert.equal(importFormat("/in/#foreign file." + extension.toUpperCase()), reader);
  for (const file of ["source.md", "source.pdf", "/folder.docx/no-extension", "docx", "source.docx.exe"]) assert.equal(importFormat(file), null);
  assert.equal(importDefaultPath("/in/a.b.docx"), "/in/a.b.md");
  assert.equal(importDefaultPath("/in/source.mdx", "/library/"), "/library/source.md");
  assert.equal(importDefaultPath("local.org"), "local.md");
});

const dom = new JSDOM('<!doctype html><body><div id="write" contenteditable="true" tabindex="0"></div>', { pretendToBeVisual: true, url: "http://localhost/" });
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
const imported = [], linked = [];
window.__lettrine = { settings: {}, importDocument: async (path) => { imported.push(path); return { ok: true }; } };
window.bridge = {
  path: { forFile: (file) => file.__nativePath, reference: async ({ path }) => { linked.push(path); return { reference: "source.docx" }; } },
  images: { import: async () => ({ reference: "assets/image.png" }) },
};
const { Editor } = await import("../src/renderer/editor.js");
const editor = new Editor({ root: document.getElementById("write") });
window.__lettrine.editor = editor;
const drop = (paths) => ({ preventDefault() {}, target: editor.root, clientX: 0, clientY: 0, dataTransfer: { files: paths.map((path) => ({ __nativePath: path, name: path.split("/").at(-1), type: "" })) } });
function reset(settings) {
  imported.length = 0; linked.length = 0; editor.setReadOnly(false); editor.__settings = settings;
  editor.setText("Draft "); editor.root.focus(); editor.selectOffsets(6);
}
test("imports: editor drops retain file-link behavior by default", async () => {
  reset({});
  await editor._handleDrop(drop(["/tmp/source.docx"]));
  assert.equal(editor.getMarkdown(), "Draft [source.docx](source.docx)");
  assert.deepEqual(linked, ["/tmp/source.docx"]); assert.deepEqual(imported, []);
  editor.undo(); assert.equal(editor.getMarkdown(), "Draft ");
});
test("imports: opt-in conversion leaves the current source and history intact", async () => {
  reset({ editorFileDrop: "import" }); const history = editor._history.length;
  await editor._handleDrop(drop(["/tmp/source.docx", "/tmp/other.html"]));
  assert.equal(editor.getMarkdown(), "Draft "); assert.equal(editor._history.length, history);
  assert.deepEqual(imported, ["/tmp/source.docx", "/tmp/other.html"]); assert.deepEqual(linked, []);
});
test("imports: mixed image/document drops preserve image insertion and readonly guards", async () => {
  reset({ editorFileDrop: "import" });
  await editor._handleDrop(drop(["/tmp/source.docx", "/tmp/image.png"]));
  assert.equal(editor.getMarkdown(), "Draft ![](assets/image.png)");
  assert.deepEqual(imported, ["/tmp/source.docx"]);
  editor.setReadOnly(true); await editor._handleDrop(drop(["/tmp/blocked.docx"]));
  assert.deepEqual(imported, ["/tmp/source.docx"]);
});
