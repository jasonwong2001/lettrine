import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { formatCodeBody, codeOptions, codeRanges, codeFormatEdits, applyCodeEdits, codeSelectionAfter, codeLanguageMatches, newCodeLanguage } from "../src/core/code-tools.js";

const dom = new JSDOM('<!doctype html><body><div id="md-content"><div id="write" contenteditable="true" tabindex="0"></div></div>', { url: "http://localhost/", pretendToBeVisual: true, runScripts: "outside-only" });
for (const file of ["lib/codemirror.js", "addon/mode/simple.js", ...["javascript", "python", "clike", "css", "ruby", "shell", "yaml", "rust", "xml"].map((name) => `mode/${name}/${name}.js`)]) {
  dom.window.eval(readFileSync(new URL("../node_modules/codemirror/" + file, import.meta.url), "utf8"));
}
const CM = dom.window.CodeMirror;
globalThis.window = dom.window; globalThis.document = dom.window.document; globalThis.HTMLElement = dom.window.HTMLElement;
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.requestAnimationFrame = (fn) => setTimeout(fn, 0);
window.bridge = { path: { fileURL: (file) => "file://" + file } };
const { Editor, blockSourceFromEl } = await import("../src/renderer/editor.js");
const { formatCodeInApp } = await import("../src/renderer/code-tools.js");
const { toggleCodeFence } = await import("../src/renderer/editor-ops.js");
const editor = new Editor({ root: document.getElementById("write") });
const app = { editor, settings: { codeIndentSize: 2 }, notify() {} }; window.__lettrine = app;
const setText = (text) => { editor.setReadOnly(false); editor.__settings = app.settings; editor.setText(text); editor.root.focus(); };

test("code tools: formatting changes only whitespace, is idempotent and preserves execution and JSON data", () => {
  const source = 'function example(name) {\nconst label = "  " + name;   \nif (name) {\nreturn label;\n}\nreturn "empty";\n}\nexample("Ready");';
  for (const codeIndentSize of [1, 2, 4, 8]) {
    for (const indentWithTabs of [false, true]) {
      const settings = { codeIndentSize, tabSize: 4, indentWithTabs };
      const after = formatCodeBody(CM, source, "javascript", settings, { prettify: true });
      assert.equal(after.replace(/\s/g, ""), source.replace(/\s/g, ""));
      assert.equal(vm.runInNewContext(after), vm.runInNewContext(source));
      assert.equal(formatCodeBody(CM, after, "javascript", settings, { prettify: true }), after);
      assert.ok(!/[ \t]+$/m.test(after));
    }
  }
  const json = '{\n"items": [\n{"name": "  retain  this  "}\n]\n}';
  const after = formatCodeBody(CM, json, "json", { codeIndentSize: 2 }, { prettify: true });
  assert.deepEqual(JSON.parse(after), JSON.parse(json)); assert.match(after, /\n  "items": \[\n    \{/);
  for (const [language, source] of [["ts", "function value(x: number) {\nreturn x;\n}"], ["c", "int value() {\nreturn 1;\n}"], ["css", ".item {\ncolor: red;\n}"], ["ruby", 'def value\nputs "ready"\nend'], ["rust", "fn value() {\nprintln!(\"ready\");\n}"]]) {
    const output = formatCodeBody(CM, source, language, { codeIndentSize: 2 }, { prettify: true });
    assert.ok(output.includes("\n  "), language);
    assert.equal(output.replace(/\s/g, ""), source.replace(/\s/g, ""));
    assert.equal(formatCodeBody(CM, output, language, { codeIndentSize: 2 }, { prettify: true }), output);
  }
});

test("code tools: literal whitespace, comments, heredocs and continuation lines stay exact", () => {
  const source = 'function value() {\nconst text = `first\n  significant spaces  \nlast`;\n/* comment\n  keep comment spaces  \n*/\nreturn text;\n}\nvalue();';
  const after = formatCodeBody(CM, source, "js", { codeIndentSize: 2 }, { prettify: true });
  assert.equal(vm.runInNewContext(after), vm.runInNewContext(source));
  assert.ok(after.includes("`first\n  significant spaces  \nlast`"));
  assert.ok(after.includes("/* comment\n  keep comment spaces  \n*/"));
  const shell = "cat <<EOF\n  literal value  \nEOF\necho complete   ";
  assert.equal(formatCodeBody(CM, shell, "sh", {}, { prettify: true }), shell.replace(/ +$/, ""));
  const continuation = "const value = \\\\   ";
  assert.equal(formatCodeBody(CM, continuation, "js", {}, { prettify: true }), continuation);
  for (const language of ["text", "", "unknown", "html", "xml", "yaml", "markdown", "diff"]) {
    const sensitive = "  literal whitespace  \n    must remain  ";
    assert.equal(formatCodeBody(CM, sensitive, language, {}, { prettify: true }), sensitive, language);
  }
});

test("code tools: Python indentation keeps block relationships and triple-quoted values", () => {
  const source = 'if enabled:\n  run()\n  if other:\n    value = """start\n  literal indentation  \nend"""\n    work()\n  done()\nlast()';
  const after = formatCodeBody(CM, source, "python", { codeIndentSize: 4 }, { prettify: true });
  assert.equal(after, 'if enabled:\n    run()\n    if other:\n        value = """start\n  literal indentation  \nend"""\n        work()\n    done()\nlast()');
  assert.equal(formatCodeBody(CM, after, "python", { codeIndentSize: 4 }, { prettify: true }), after);
  assert.equal(formatCodeBody(CM, source, "python", { codeIndentSize: 4 }, { first: 1, last: 1, prettify: true }), source, "formatting a subset cannot change Python block relationships");
});

test("code tools: selected lines exclude an end at column zero and preserve fence/prose spelling", () => {
  const source = '# Keep   spelling\n\n  ````js extra\nif (ready) {\nfirst();   \nsecond();   \n}\n  ``````  \n\nOutside   \n\n~~~json\n{\n"key": 1\n}\n~~~';
  const range = codeRanges(source)[0], start = source.indexOf("first()"), end = source.indexOf("second()");
  const edits = codeFormatEdits(CM, source, { start, end }, { codeIndentSize: 2 }, "prettify");
  const after = applyCodeEdits(source, edits);
  assert.ok(after.includes("\n  first();\nsecond();   \n}"));
  assert.equal(after.slice(0, range.bodyStart), source.slice(0, range.bodyStart));
  assert.ok(after.endsWith("  ``````  \n\nOutside   \n\n~~~json\n{\n\"key\": 1\n}\n~~~"));
  assert.equal(codeFormatEdits(CM, after, { start, end: start }, { codeIndentSize: 2 }, "prettify", "whole").length, 1);
  const whole = codeFormatEdits(CM, source, { start: 0, end: source.length }, { codeIndentSize: 2 }, "indent", "whole");
  assert.equal(whole.length, 2);
  assert.ok(applyCodeEdits(source, whole).includes("first();   "), "auto indent retains trailing spaces");
});

test("code tools: selections follow tokens when both indentation and trailing whitespace change", () => {
  const source = "```js\nif (ready) {\nfirst();   \nsecond();\n}\n```", start = source.indexOf("first"), end = start + 5;
  const edits = codeFormatEdits(CM, source, { start, end }, { codeIndentSize: 4 }, "prettify");
  const after = applyCodeEdits(source, edits), mapped = codeSelectionAfter(source, edits, { start, end, backward: true });
  assert.equal(after.slice(mapped.start, mapped.end), "first");
  assert.equal(mapped.backward, true);
  const caret = codeSelectionAfter(source, edits, { start: end, end });
  assert.equal(after.slice(caret.start - 5, caret.start), "first");
});

test("code tools: code settings, defaults and language suggestions are bounded and deterministic", () => {
  assert.deepEqual(codeOptions({ tabSize: 8, codeIndentSize: 2, indentWithTabs: true }), { tabSize: 8, indentUnit: 2, indentWithTabs: true });
  assert.deepEqual(codeOptions({ tabSize: 999, codeIndentSize: -1 }), { tabSize: 16, indentUnit: 16, indentWithTabs: false });
  assert.equal(newCodeLanguage({ defaultCodeLanguage: "python\n```" }, "js"), "python");
  assert.equal(newCodeLanguage({}, "js"), "js");
  assert.deepEqual(codeLanguageMatches("JAV"), ["java", "javascript"]);
  assert.deepEqual(codeLanguageMatches("no-such-language"), []);
});

test("code tools: preview formatting is one undo step and keeps untouched block identities", () => {
  const source = "Before\n\n```js\nif (ready) {\nrun();   \n}\n```\n\nAfter";
  setText(source); editor.selectOffsets(source.indexOf("run"));
  const first = editor.root.firstElementChild, last = editor.root.lastElementChild;
  assert.equal(formatCodeInApp(app, "prettify"), true);
  assert.equal(editor.getMarkdown(), source.replace("run();   ", "  run();"));
  assert.equal(editor.root.firstElementChild, first); assert.equal(editor.root.lastElementChild, last);
  assert.equal(blockSourceFromEl(editor.root.children[1]), editor.blocks[1].src);
  const count = editor._history.length;
  assert.equal(formatCodeInApp(app, "prettify"), false); assert.equal(editor._history.length, count);
  editor.undo(); assert.equal(editor.getMarkdown(), source);
  editor.setReadOnly(true); assert.equal(formatCodeInApp(app, "prettify"), false); assert.equal(editor.getMarkdown(), source);
});

test("code tools: default language applies to menu-created fences without rewriting existing fences", () => {
  app.settings.defaultCodeLanguage = "python";
  setText("Existing paragraph"); editor.selectOffsets(5);
  toggleCodeFence(editor);
  assert.equal(editor.blocks[0].info, "python"); assert.ok(editor.getMarkdown().startsWith("```python\n"));
  editor.undo(); assert.equal(editor.getMarkdown(), "Existing paragraph");
  setText("```js\nconst value = 1;\n```");
  assert.equal(editor.blocks[0].info, "js");
  app.settings.defaultCodeLanguage = "";
});

test("code tools: fence-marker completion supports keyboard selection, Escape and readonly", () => {
  setText("```jav"); editor.selectOffsets(6);
  editor.root.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText", data: "v" }));
  const popup = document.getElementById("ui-code-languages");
  assert.ok(popup); assert.deepEqual([...popup.children].map((option) => option.textContent), ["java", "javascript"]);
  editor.root.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "ArrowDown" }));
  editor.root.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Tab" }));
  assert.equal(editor.getMarkdown(), "```javascript"); assert.equal(document.getElementById("ui-code-languages"), null);
  setText("```py"); editor.selectOffsets(5);
  editor.root.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
  assert.ok(document.getElementById("ui-code-languages"));
  editor.root.dispatchEvent(new window.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Escape" }));
  assert.equal(editor.getMarkdown(), "```py"); assert.equal(document.getElementById("ui-code-languages"), null);
  editor.setReadOnly(true);
  editor.root.dispatchEvent(new window.InputEvent("input", { bubbles: true, inputType: "insertText" }));
  assert.equal(document.getElementById("ui-code-languages"), null);
});

test("code tools: opener selections and language typing keep exact source offsets through delayed rendering", () => {
  setText("```python"); editor.selectOffsets(3, 9);
  assert.equal(window.getSelection().toString(), "python");
  assert.deepEqual(editor.selectionOffsets(), { start: 3, end: 9, backward: false });
  editor._brushPass([0]);
  assert.equal(window.getSelection().toString(), "python");
  assert.deepEqual(editor.selectionOffsets(), { start: 3, end: 9, backward: false });
  editor.replaceSelection("jav");
  assert.equal(editor.getMarkdown(), "```jav");
  assert.deepEqual(editor.selectionOffsets(), { start: 6, end: 6, backward: false });
  editor._afterTextInput({ inputType: "insertText" });
  assert.ok(document.getElementById("ui-code-languages"));
});

test("code tools: language completion closes when focus leaves the document", () => {
  setText("```jav"); editor.selectOffsets(6);
  editor._afterTextInput({ inputType: "insertText" });
  assert.ok(document.getElementById("ui-code-languages"));
  const input = document.createElement("input"); document.body.appendChild(input);
  input.focus();
  assert.equal(document.getElementById("ui-code-languages"), null);
  input.remove();
});
