// Native clipboard flavors, menu commands and structural edits in WKWebView.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { resolveRuntime } from "./runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(path.join(os.tmpdir(), "lettrine-clipboard-")), profile = path.join(dir, "profile");
await mkdir(profile);
await writeFile(path.join(profile, "settings.json"), JSON.stringify({ autosave: false, locale: "en", background: "light" }));
await writeFile(path.join(dir, "pixel.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect width="24" height="24" fill="#e63224"/></svg>');
const body = "  const value = 1;  \n\tfinish();", tex = "\\frac{1}{2}\\label{half}";
const table = "| Left | Right |\n| :--- | ---: |\n| a\\|b | `c|d` |";
const source = [
  "# Clipboard and selection",
  "Before **strong *inner* text** and $x^2 + 1$. Next sentence!\nSecond line.",
  "> Quoted $y+1$.",
  "$$\n" + tex + "\n$$",
  "````js\n" + body + "\n``````  ",
  table,
  "3. Item with a [link](https://example.org)\n4. Next item",
  "![Local pixel](pixel.svg)",
  "After stays  ",
].join("\n\n");
const doc = path.join(dir, "clipboard.md"); await writeFile(doc, source);
const A = "window.__lettrine", E = `${A}.editor`, S = `${A}._sourceCM`, C = `${E}.root.querySelector('pre').__cm`, M = `${E}.root.querySelector('.md-math-block').__cm`, q = JSON.stringify;
const check = (name, expr, eq = true) => ({ assert: { name, expr, eq } });
const setPreview = (text) => ({ eval: `${E}.root.focus();${E}.setText(${q(text)},{docBase:${q(doc)}});${E}.selectOffsets(0)` });
const caret = (point) => ({ eval: `${E}.root.focus();${E}.selectOffsets(${point})` });
const copied = (command) => [
  { eval: "window.__copyBefore=__copyWrites" }, { cmd: command },
  { waitFor: "__copyWrites>__copyBefore" },
  { eval: "(async()=>{window.__clip=await window.bridge.clipboard.readContent();return true;})()" },
];
const mountCode = { eval: `${E}.root.querySelector('pre').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))` };
const mountMath = { eval: `${E}.root.querySelector('.md-math-block').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))` };
const codeSource = "Before\n\n````js\n" + body + "\n``````  \n\nAfter";
const selectionSource = "Before\n\n## Heading\n\nCafe\u0301 😀 编写中文。 Next sentence!\nSecond line.\n\nAfter";
const steps = [
  { open: doc }, { focusWindow: true },
  ...[
    ["edit.copyMathML", "Copy as MathML"], ["edit.copyTeX", "Copy as TeX"], ["edit.copyCode", "Copy Code Content"],
    ["edit.copyTable", "Copy Table"], ["edit.copyCleanHTML", "Copy without Theme Styling"],
    ["edit.selectBlock", "Select Paragraph / Block"], ["edit.selectSentence", "Select Sentence"],
    ["edit.deleteBlock", "Delete Paragraph / Block"], ["edit.deleteLine", "Delete Line"], ["edit.deleteSentence", "Delete Sentence"],
  ].map(([command, label]) => ({ assertMenu: { id: "command." + command, property: "label", eq: label, name: label + " is in the native Edit menu" } })),
  { eval: "window.__copyWrites=0;window.__writeClipboard=window.bridge.clipboard.write;window.bridge.clipboard.write=async(payload)=>{const result=await __writeClipboard(payload);__copyWrites++;return result;};true" },
  caret(source.indexOf("x^2") + 1),
  { eval: `window.__copySelection=${E}.selectionOffsets();window.__copyHistory=${E}._history.length` },
  ...copied("edit.copyTeX"),
  check("TeX is plain text without delimiters or an HTML flavor", "__clip.text==='x^2 + 1'&&__clip.html===''&&!__clip.hasImage"),
  ...copied("edit.copyMathML"),
  check("MathML is a standalone XML math element in both native clipboard flavors", "(()=>{const xml=new DOMParser().parseFromString(__clip.text,'application/xml');return !xml.querySelector('parsererror')&&xml.documentElement.localName==='math'&&xml.documentElement.namespaceURI==='http://www.w3.org/1998/Math/MathML'&&__clip.text===__clip.html&&!__clip.hasImage;})()"),
  check("special copy keeps the source, selection, history and saved state", `${E}.getMarkdown()===${q(source)}&&JSON.stringify(${E}.selectionOffsets())===JSON.stringify(__copySelection)&&${E}._history.length===__copyHistory&&!${A}._dirty`),
  caret(source.indexOf("y+1") + 1), ...copied("edit.copyTeX"),
  check("nested-quote formula copy uses the formula body", "__clip.text", "y+1"),
  caret(source.indexOf("\\frac") + 3), ...copied("edit.copyTeX"),
  check("display TeX keeps labels and exact source", "__clip.text", tex),
  ...copied("edit.copyMathML"),
  check("display MathML contains its fraction without TeX label commands", "__clip.text.includes('display=\"block\"')&&__clip.text.includes('<mfrac>')&&!__clip.text.includes('\\\\label')"),
  mountMath, { waitFor: `!!${M}` },
  { eval: `window.__math=${M};__math.replaceRange(' + 2',__math.posFromIndex(__math.getValue().length),null,'+input');__math.focus();window.__mathSelection=JSON.stringify(__math.listSelections());window.__mathHistory=${E}._history.length` },
  { eval: `${A}.copySpecial('tex',${E}.root.querySelector('.md-math-block > .md-math-body'))` },
  { eval: "(async()=>{window.__clip=await window.bridge.clipboard.readContent();return true;})()" },
  check("formula context copy reads live TeX without closing the editor", `__clip.text===${q(tex + " + 2")}&&${M}===__math&&JSON.stringify(__math.listSelections())===__mathSelection&&${E}._history.length===__mathHistory`),
  { cmd: "edit.deleteLine" },
  check("math line deletion keeps the original display delimiters", `${E}.getMarkdown()`, source.replace(tex, "")),
  { key: "Meta+Z" },
  check("math range deletion has its own undo step", `${E}.getMarkdown()`, source.replace(tex, tex + " + 2")),
  { key: "Meta+Z" },
  check("formula typing remains undoable after copying", `${E}.getMarkdown()`, source),
  setPreview(codeSource), caret(codeSource.indexOf("const") + 2), ...copied("edit.copyCode"),
  check("code copy preserves its whole exact body, tabs and trailing spaces without fences", "__clip.text", body),
  mountCode, { waitFor: `!!${C}` },
  { eval: `window.__code=${C};__code.replaceRange(' // live',__code.posFromIndex(__code.getValue().length),null,'+input');__code.setSelection({line:0,ch:2},{line:0,ch:7});__code.focus()` },
  { eval: `${A}.copySpecial('code',${E}.root.querySelector('pre'))` },
  { eval: "(async()=>{window.__clip=await window.bridge.clipboard.readContent();return true;})()" },
  check("code context copy reads the live model and copies the entire body despite a partial selection", `__clip.text===${q(body + " // live")}&&${C}===__code&&__code.getSelection()==='const'`),
  { key: "Meta+Shift+D" },
  check("native Delete Word deletes the active code selection without its fence", `${E}.getMarkdown()`, codeSource.replace(body, (body + " // live").replace("const", ""))),
  { key: "Meta+Z" }, { waitFor: `!!${C}` },
  check("code range deletion has its own undo step", `${E}.getMarkdown()`, codeSource.replace(body, body + " // live")),
  { key: "Meta+Z" },
  check("code history from before the command is retained", `${E}.getMarkdown()`, codeSource),
  { waitFor: `!!${C}` }, { eval: `${C}.setCursor({line:0,ch:5});${C}.focus()` },
  { cmd: "edit.selectScope" },
  check("a mounted code styled scope selects its exact body", `${C}.getSelection()`, body),
  { cmd: "edit.selectBlock" },
  check("block selection leaves the mounted editor and includes exact fences plus its separator", `(()=>{const selection=${E}.selectionOffsets();return ${E}.getMarkdown().slice(selection.start,selection.end);})()`, codeSource.slice(8, -5)),
  { cmd: "edit.deleteBlock" },
  check("deleting a selected code block keeps the following paragraph", `${E}.getMarkdown()`, "Before\n\nAfter"),
  { key: "Meta+Z" },
  check("one undo restores the exact code fences, body and separator", `${E}.getMarkdown()`, codeSource),
  setPreview(source), caret(source.indexOf("a\\|b")), ...copied("edit.copyTable"),
  check("pipe-table copy retains delimiter alignment, escaped pipes and code spans", "__clip.text=== " + q(table) + "&&__clip.html===''"),
  setPreview("Before **selected** after"), { eval: `${E}.selectOffsets(9,17)` }, ...copied("edit.copyCleanHTML"),
  check("clean rich HTML keeps partial inline formatting with readable plain text", "__clip.text==='selected'&&__clip.html.includes('<strong>selected</strong>')&&!/style=|class=|data-|md-attr|contenteditable|<script|<style/.test(__clip.html)"),
  ...copied("edit.copyHTML"),
  check("Copy as HTML Code writes literal semantic HTML as plain text", "__clip.text.includes('<strong>selected</strong>')&&__clip.html===''"),
  setPreview(source), ...copied("edit.copyCleanHTML"),
  check("whole-document clean HTML preserves headings, lists, tables, code and MathML without theme styles", "__clip.text.includes('Clipboard and selection')&&__clip.html.includes('<h1>Clipboard and selection</h1>')&&__clip.html.includes('<ol start=\"3\">')&&__clip.html.includes('<table>')&&__clip.html.includes('<pre>')&&__clip.html.includes('<math ')&&!/style=|class=|data-|contenteditable|<script|<style/.test(__clip.html)"),
  { waitFor: `!!${E}.root.querySelector('.md-img-loaded')` },
  caret(source.indexOf("![Local")), { cmd: "edit.selectBlock" }, ...copied("edit.copyCleanHTML"),
  check("selected local images are portable HTML data rather than app-only URLs", "__clip.html.includes('src=\"data:image/svg+xml;base64,')&&__clip.html.includes('alt=\"Local pixel\"')&&!__clip.html.includes('lettrine://')"),
  setPreview(selectionSource), caret(selectionSource.indexOf("Cafe") + 2), { cmd: "edit.selectWord" },
  check("word selection keeps combining marks together", "window.getSelection().toString()", "Cafe\u0301"),
  caret(selectionSource.indexOf("😀") + 1), { cmd: "edit.selectWord" },
  check("word selection never splits an emoji surrogate pair", "window.getSelection().toString()", "😀"),
  caret(selectionSource.indexOf("编写") + 1), { cmd: "edit.selectWord" },
  check("word selection follows Unicode word boundaries in Chinese", "window.getSelection().toString()", "编写"),
  caret(selectionSource.indexOf("Next") + 2), { cmd: "edit.selectSentence" },
  check("sentence selection remains inside its paragraph", `(()=>{const s=${E}.selectionOffsets();return ${E}.getMarkdown().slice(s.start,s.end);})()`, "Next sentence!\n"),
  caret(selectionSource.indexOf("Next") + 2), { cmd: "edit.lineStart" },
  check("jump to line start resolves the source line", `${E}.selectionOffsets().start`, selectionSource.indexOf("Cafe")),
  { cmd: "edit.lineEnd" },
  check("jump to line end resolves the source line", `${E}.selectionOffsets().start`, selectionSource.indexOf("\nSecond")),
  { key: "Meta+L" },
  check("native Select Line selects the current source line", "window.getSelection().toString()", "Cafe\u0301 😀 编写中文。 Next sentence!"),
  { cmd: "edit.deleteLine" },
  check("deleting a selected line preserves its unselected newline and adjacent blocks", `${E}.getMarkdown()`, selectionSource.replace("Cafe\u0301 😀 编写中文。 Next sentence!", "")),
  { key: "Meta+Z" },
  caret(selectionSource.indexOf("Next") + 2), { cmd: "edit.deleteSentence" },
  check("sentence deletion is source-based and does not delete the next source line", `${E}.getMarkdown()`, selectionSource.replace("Next sentence!\n", "")),
  { key: "Meta+Z" },
  { capture: "selection-light" },
  { cmd: "view.source" }, { waitFor: `!!${S}` },
  { eval: `${S}.setValue(${q(selectionSource)});${S}.clearHistory();${S}.setCursor(${S}.posFromIndex(${selectionSource.indexOf("Next") + 2}));${S}.focus()` },
  { type: "X" },
  { eval: `window.__typedSource=${S}.getValue();${S}.setCursor(${S}.posFromIndex(${selectionSource.indexOf("Second") + 2}));${S}.focus()` },
  { cmd: "edit.deleteLine" },
  check("source deletion uses its current caret and keeps source view open", `${S}.getValue()===__typedSource.replace('\\nSecond line.','')&&document.body.classList.contains('sourceview-on')`),
  { key: "Meta+Z" },
  check("source range deletion is an independent CodeMirror undo step", `${S}.getValue()===__typedSource`),
  { key: "Meta+Z" },
  check("source history from before structural deletion survives", `${S}.getValue()`, selectionSource),
  { key: "Meta+Shift+Z" }, { key: "Meta+Shift+Z" },
  check("source structural deletion participates in redo", `${S}.getValue()===__typedSource.replace('\\nSecond line.','')`),
  { eval: `${S}.setValue(${q(source)});${S}.setCursor(${S}.posFromIndex(${source.indexOf("const") + 2}));${S}.focus()` },
  ...copied("edit.copyCode"),
  check("source-mode code copy is fence-body text, even with a collapsed selection", "__clip.text", body),
  { eval: `${S}.setCursor(${S}.posFromIndex(${source.indexOf("a\\|b")}));${S}.focus()` },
  ...copied("edit.copyTable"),
  check("source-mode table copy uses exact source", "__clip.text", table),
  { eval: `${S}.setCursor(${S}.posFromIndex(${source.indexOf("\\frac") + 1}));${S}.focus()` },
  ...copied("edit.copyMathML"),
  check("source-mode MathML also supplies both native formats", "__clip.text.includes('<mfrac>')&&__clip.text===__clip.html"),
  { eval: `${S}.setCursor(${S}.posFromIndex(${source.indexOf("\n\n") + 1}));${S}.focus()` },
  { cmd: "edit.lineStart" }, { cmd: "edit.lineEnd" },
  check("source line jumps stay on a blank separator line", `${S}.indexFromPos(${S}.getCursor())`, source.indexOf("\n\n") + 1),
  { cmd: "edit.deleteLine" },
  check("deleting a blank source line never deletes the next paragraph", `${S}.getValue()`, source.replace("\n\n", "\n")),
  { key: "Meta+Z" },
  { cmd: "view.readonly" }, { cmd: "edit.deleteBlock" },
  check("readonly source permits copy and selection while rejecting structural deletion", `${S}.getValue()===${q(source)}&&${E}.readOnly`),
  { cmd: "view.readonly" }, { cmd: "view.source" },
  setPreview("Before **styled *inner* text** after"), caret(20), { cmd: "edit.selectScope" },
  check("styled scope selects the innermost inline contents without delimiters", "window.getSelection().toString()", "inner"),
  { cmd: "view.readonly" }, { cmd: "edit.deleteWord" },
  ...copied("edit.copyCleanHTML"),
  check("readonly preview preserves formatting and source while allowing special copy", `${E}.getMarkdown()==='Before **styled *inner* text** after'&&__clip.text==='inner'&&__clip.html.includes('<em>inner</em>')`),
  { cmd: "view.readonly" },
  { eval: `${A}.setTheme('lettrine-dark')` }, { waitFor: "document.body.classList.contains('ui-dark')" },
  ...copied("edit.copyCleanHTML"),
  check("dark-theme clean HTML has no theme attributes or CSS", "!/style=|class=|data-|<style/.test(__clip.html)&&__clip.html.includes('<em>inner</em>')"),
  { capture: "selection-dark" },
  { cmd: "file.preferences" },
  { eval: "document.querySelector('[data-pane=editor]').click();window.__field=document.getElementById('pref-extra-codeIndentSize');__field.focus();window.__fieldValue=__field.value" },
  { cmd: "edit.deleteBlock" }, { cmd: "edit.selectBlock" }, { cmd: "edit.copyTeX" },
  check("modal text controls retain focus, value and document contents", `document.activeElement===__field&&__field.value===__fieldValue&&${E}.getMarkdown()==='Before **styled *inner* text** after'`),
  { eval: "document.getElementById('preferences-done').click()" },
  { eval: "window.bridge.i18n.setLocale({locale:'zh-Hans'})" }, { waitFor: `${A}.i18n.locale==='zh-Hans'` },
  { assertMenu: { id: "command.edit.copyCleanHTML", property: "label", eq: "复制时移除主题样式", name: "copy commands have Simplified Chinese labels" } },
  { assertMenu: { id: "command.edit.deleteBlock", property: "label", eq: "删除段落或块", name: "delete commands have Simplified Chinese labels" } },
  caret(0), { eval: `${A}.copySpecial('tex')` },
  check("copy errors are localized and leave the old clipboard intact", "(async()=>{const c=await window.bridge.clipboard.readContent();return c.text===__clip.text&&document.getElementById('md-notification').textContent.includes('请将光标放在公式中');})()"),
  { eval: "window.bridge.i18n.setLocale({locale:'zh-Hant'})" }, { waitFor: `${A}.i18n.locale==='zh-Hant'` },
  { assertMenu: { id: "command.edit.selectSentence", property: "label", eq: "選取句子", name: "selection commands have Traditional Chinese labels" } },
  { assertMenu: { id: "command.edit.lineEnd", property: "label", eq: "跳到行尾", name: "line navigation has Traditional Chinese labels" } },
  check("no renderer errors", "window.__lettrineStartupErrors", []),
];
const scenario = path.join(dir, "scenario.json"); await writeFile(scenario, JSON.stringify(steps, null, 2));
const { executable, args } = await resolveRuntime(root, process.argv[2]);
const child = spawn(executable, [...args, "--user-data-dir=" + profile, "--lettrine-harness", scenario, "--lettrine-out", dir], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; child.stdout.on("data", (data) => { log += data; }); child.stderr.on("data", (data) => { log += data; });
const timer = setTimeout(() => child.kill("SIGTERM"), 180000);
let code;
try { code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }); }
finally { clearTimeout(timer); }
await writeFile(path.join(dir, "native.log"), log); console.log("Clipboard and selection report: " + dir);
const report = JSON.parse(await readFile(path.join(dir, "report.json"), "utf8"));
for (const item of report.filter((item) => item.op === "assert" || item.ok === false)) console.log(`${item.ok ? "PASS" : "FAIL"} ${item.name || item.error}`);
assert.equal(code, 0, "Clipboard and selection native scenario failed");
assert.equal(await readFile(doc, "utf8"), source, "Clipboard and selection commands never silently save a draft");
console.log("PASS native pasteboard text/HTML, exact formula/code/table copy, clean HTML, structural selection/deletion, history, source mode, readonly, themes and localization");
