// Native select-all/deletion must operate on Markdown, including math and metadata.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { resolveRuntime } from "./runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(path.join(os.tmpdir(), "lettrine-math-selection-"));
const profile = path.join(directory, "profile"); await mkdir(profile);
await writeFile(path.join(profile, "settings.json"), JSON.stringify({ locale: "en", autosave: false, background: "light" }));
const A = "window.__lettrine", E = `${A}.editor`, formula = "$$\nx^2+y^2=z^2\n$$";
const check = (name, expr, eq = true) => ({ assert: { name, expr, eq } });
const mathLayout = `(()=>{
  const block=document.querySelector('[mdtype=math_block]'),source=block.querySelector('.md-math-source');
  const markers=source.querySelectorAll(':scope > .md-attr, :scope > .md-tag');
  const opening=markers[0].getBoundingClientRect(),closing=markers[1].getBoundingClientRect();
  const markerRange=document.createRange();markerRange.selectNodeContents(markers[0]);
  const markerText=markerRange.getBoundingClientRect();
  const cm=block.__cm,frame=cm.getWrapperElement(),code=frame.getBoundingClientRect();
  const panel=source.getBoundingClientRect(),preview=block.querySelector('.md-mathjax-preview').getBoundingClientRect();
  const style=getComputedStyle(frame),lineHeight=parseFloat(style.lineHeight);
  const fontSize=parseFloat(style.fontSize),inset=cm.charCoords({line:0,ch:0},'window').left-markerText.left;
  return {
    delimitersFrameTeX:opening.bottom<=code.top+1&&code.bottom<=closing.top+1,
    previewFollowsSource:closing.bottom<=panel.bottom&&Math.abs(preview.top-panel.bottom)<2,
    subtleDelimiters:parseFloat(getComputedStyle(markers[0]).fontSize)<fontSize&&Math.abs(opening.left-closing.left)<1,
    insetSource:inset>fontSize*.2&&inset<fontSize*.4,
    compactSource:panel.height<=lineHeight*(cm.lineCount()+2)+12,
    sharedSurface:style.borderTopWidth==='0px'&&style.backgroundColor===getComputedStyle(source).backgroundColor
  };
})()`;
const expectedMathLayout = { delimitersFrameTeX: true, previewFollowsSource: true, subtleDelimiters: true, insetSource: true, compactSource: true, sharedSurface: true };
const steps = [{ focusWindow: true }, { eval: "window.__selectionErrors=[];addEventListener('error',e=>__selectionErrors.push(e.message));addEventListener('unhandledrejection',e=>__selectionErrors.push(String(e.reason)))" }];
for (const [name, source, key] of [
  ["only formula", formula, "Backspace"],
  ["formula at end", "Before\n\n" + formula, "Delete"],
  ["formula at start", formula + "\n\nAfter\n", "Backspace"],
  ["multiple formulas and code", "# Heading\n\n" + formula + "\n\n```js\nconst x=1;\n```\n\n" + formula, "Delete"],
  ["only metadata", "---\ntitle: Example\n---", "Backspace"],
  ["metadata and body", "---\ntitle: Example\n---\n\n# Heading\n\nBody\n", "Delete"],
  ["unfinished metadata", "---\n", "Backspace"],
]) {
  steps.push(
    { eval: `${E}.setText(${JSON.stringify(source)});${E}.root.focus();` },
    { key: "Meta+A" },
    { eval: `({selection:${E}.selectionOffsets(),text:getSelection().toString(),anchor:getSelection().anchorNode.nodeName,focus:getSelection().focusNode.nodeName})` },
    ...(source.startsWith("---\n") ? [
      check(`${name}: selection starts in editable YAML and excludes its caption`, "(()=>{const selection=getSelection(),source=document.querySelector('[mdtype=frontmatter]>.md-plain');return source.contains(selection.getRangeAt(0).startContainer)&&!selection.toString().includes('YAML Front Matter');})()"),
      { key: "Meta+Shift+C" },
      check(`${name}: Copy as Markdown preserves the complete source`, "(async()=> (await window.bridge.native.invoke('clipboard.readContent')).text)()", source),
    ] : []),
    { key },
    check(`${name}: Select All and ${key} remove every source character`, `${E}.getMarkdown()`, ""),
    check(`${name}: deletion leaves a focused editable paragraph`, `${E}.root.children.length===1&&${E}.root.firstElementChild.matches('p[mdtype=paragraph]')&&document.activeElement===${E}.root`),
    { key: "Meta+Z" },
    check(`${name}: Undo restores the exact source`, `${E}.getMarkdown()`, source),
    { key: "Meta+Shift+Z" },
    check(`${name}: Redo deletes it again`, `${E}.getMarkdown()`, ""),
    { type: "continue typing" },
    check(`${name}: typing after deletion stays in the document`, `${E}.getMarkdown()`, "continue typing"),
  );
}
steps.push(
  { eval: `(async()=>{${A}._dirty=false;await ${A}.newDocument()})()` },
  { type: "$$" }, { key: "Enter" },
  { waitFor: "!!document.querySelector('[mdtype=math_block]')?.__cm" },
  check("Enter pairs the math delimiters and adds a following paragraph", `${E}.getMarkdown()`, "$$\n\n$$\n\n"),
  check("the completed formula owns focus with the caret in its empty TeX body", "(()=>{const cm=document.querySelector('[mdtype=math_block]').__cm;return cm.hasFocus()&&cm.indexFromPos(cm.getCursor())===0;})()"),
  check("empty math keeps both delimiters in one compact source panel above the preview", mathLayout, expectedMathLayout),
  { capture: "auto-completed-math" },
  { key: "Meta+Z" },
  check("one Undo restores the bare math opener and its caret", `${E}.getMarkdown()==='$$'&&${E}.caretInfo().offset===2&&!document.querySelector('[mdtype=math_block]').__cm`),
  { key: "Meta+Shift+Z" },
  { waitFor: "!!document.querySelector('[mdtype=math_block]')?.__cm" },
  check("Redo restores the completed formula and its body caret", `${E}.getMarkdown()==='$$\\n\\n$$\\n\\n'&&${E}.caretInfo().offset===3`),
  { click: ".md-math-done" },
  check("finishing unchanged math removes the editor and its extra preview", `${E}.getMarkdown()==='$$\\n\\n$$\\n\\n'&&!document.querySelector('[mdtype=math_block]').__cm&&!document.querySelector('.md-mathblock-panel, .md-mathjax-preview')&&getComputedStyle(document.querySelector('.md-math-source')).display==='none'`),
  { eval: "document.querySelector('[mdtype=math_block]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))" },
  { waitFor: "!!document.querySelector('[mdtype=math_block]')?.__cm" },
  check("reopening unchanged math creates one editor and one live preview", "document.querySelectorAll('.md-mathblock-panel').length===1&&document.querySelectorAll('.md-mathjax-preview').length===1"),
  { type: "x+y" }, { key: "Enter" }, { type: "$$" },
  { waitFor: "!document.querySelector('[mdtype=math_block]').__cm" },
  { click: "[mdtype=math_block] .md-math-body" },
  { waitFor: "!!document.querySelector('[mdtype=math_block]')?.__cm" },
  check("a native pointer click opens the formula and retains TeX focus", "document.querySelector('[mdtype=math_block]').__cm.hasFocus()"),
  { click: "[mdtype=math_block] .md-mathjax-preview" },
  check("clicking the live preview retains the active math editor", "document.querySelector('[mdtype=math_block]').__cm?.hasFocus()===true"),
  { click: ".md-math-done" },
  { key: "Meta+A" }, { key: "Backspace" },
  check("a freshly typed formula and its trailing paragraph can be deleted together", `${E}.getMarkdown()`, ""),
  { key: "Meta+Z" },
  check("Undo restores the typed formula and trailing paragraph", `${E}.getMarkdown()`, "$$\nx+y\n$$\n\n"),
  { eval: `(async()=>{${A}._dirty=false;await ${A}.newDocument()})()` },
  { type: "$$" }, { key: "Enter" },
  { waitFor: "!!document.querySelector('[mdtype=math_block]')?.__cm" },
  { type: "a+b" }, { key: "Enter" }, { type: "c+d" },
  check("multiline math retains its generated closer and following paragraph", `${E}.getMarkdown()`, "$$\na+b\nc+d\n$$\n\n"),
  check("Enter inside the formula creates a real second TeX line", "document.querySelector('[mdtype=math_block]').__cm.getValue()", "a+b\nc+d"),
  check("both TeX lines stay visible while typing the second line", "(()=>{const cm=document.querySelector('[mdtype=math_block]').__cm,r=cm.getWrapperElement().getBoundingClientRect();return cm.charCoords({line:0,ch:0},'window').top>=r.top-1&&cm.charCoords({line:1,ch:3},'window').bottom<=r.bottom+1;})()"),
  check("multiline math retains subtle delimiters and inset TeX before its preview", mathLayout, expectedMathLayout),
  { capture: "multiline-tex-input" },
  { eval: "window.__themeMathEditor=document.querySelector('[mdtype=math_block]').__cm;window.bridge.setting.put({key:'__patch',value:{background:'dark',darkTheme:'lettrine-dark'}})" },
  { waitFor: "getComputedStyle(document.querySelector('.md-mathblock-panel .CodeMirror')).backgroundColor==='rgb(37, 39, 43)'" },
  { capture: "multiline-tex-input-dark" },
  check("dark math retains the same source and preview layout", mathLayout, expectedMathLayout),
  check("dark mode preserves the active formula and follows theme colors", "(()=>{const block=document.querySelector('[mdtype=math_block]'),cm=block.__cm,style=getComputedStyle(cm.getWrapperElement()),ink=getComputedStyle(document.querySelector('#write')).color;return cm===window.__themeMathEditor&&cm.getValue()==='a+b\\nc+d'&&cm.hasFocus()&&style.color===ink&&getComputedStyle(block.querySelector('.CodeMirror-code pre')).color===ink&&getComputedStyle(block.querySelector('.CodeMirror-cursor')).borderLeftColor===ink&&getComputedStyle(block.querySelector('.md-mathjax-preview')).color===ink;})()"),
  { eval: "window.bridge.setting.put({key:'__patch',value:{background:'light',theme:'lettrine'}})" },
  { waitFor: "getComputedStyle(document.documentElement).getPropertyValue('--bg-color').trim()==='#ffffff'" },
  { key: "Meta+Enter" },
  check("Cmd-Enter finishes multiline math without adding another closer or paragraph", `${E}.getMarkdown()==='$$\\na+b\\nc+d\\n$$\\n\\n'&&!document.querySelector('[mdtype=math_block]').__cm&&${E}.caretInfo().blockIndex===1`),
  { type: "After" },
  check("typing after Cmd-Enter fills the generated following paragraph", `${E}.getMarkdown()`, "$$\na+b\nc+d\n$$\n\nAfter"),
  { cmd: "view.source" }, { waitFor: `!!${A}._sourceCM` },
  check("Source Code Mode contains the completed delimiters exactly once", `${A}._sourceCM.getValue()`, "$$\na+b\nc+d\n$$\n\nAfter"),
  { cmd: "view.source" },
  { eval: `(async()=>{${A}._dirty=false;await ${A}.newDocument()})()` },
  { type: "$$" }, { key: "Enter" },
  { waitFor: "!!document.querySelector('[mdtype=math_block]')?.__cm" },
  { type: "x+y\n$$\n\n" },
  { waitFor: "!document.querySelector('[mdtype=math_block]').__cm" },
  check("a pasted closing delimiter and blank line reuse one editable following paragraph", `${E}.getMarkdown()==='$$\\nx+y\\n$$\\n\\n'&&${E}.blocks.length===2&&${E}.caretInfo().blockIndex===1`),
  { type: "Following pasted math" },
  check("typing after pasted trailing blank lines stays outside the formula", `${E}.getMarkdown()`, "$$\nx+y\n$$\n\nFollowing pasted math"),
  { eval: `${E}.setText(${JSON.stringify(formula)});${E}.root.focus();const preview=${E}.root.querySelector('.md-math-body');const range=document.createRange();range.selectNodeContents(preview);getSelection().removeAllRanges();getSelection().addRange(range);` },
  { capture: "selected-preview" },
  { key: "Delete" },
  check("a native selection of the generated preview deletes the formula source", `${E}.getMarkdown()`, ""),
  { key: "Meta+Z" }, check("deleting a preview is undoable", `${E}.getMarkdown()`, formula),
  { eval: `${E}.setText(${JSON.stringify(formula)});${E}.root.focus();document.querySelector('[mdtype=math_block]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}));` },
  { waitFor: "!!document.querySelector('[mdtype=math_block]').__cm" },
  { key: "Meta+A" }, { key: "Backspace" },
  check("Select All inside the TeX editor clears only its editable body", `${E}.blocks[0].type==='math'&&${E}.blocks[0].closed&&document.querySelector('[mdtype=math_block]').__cm?.getValue()===''`),
  { type: "x^2" }, { click: ".md-math-done" },
  check("the checkmark finishes math and hides its source panel and controls", `${E}.getMarkdown()==='$$\\nx^2\\n$$\\n\\n'&&${E}.caretInfo().blockIndex===1&&!document.querySelector('[mdtype=math_block]').__cm&&getComputedStyle(document.querySelector('.md-math-source')).display==='none'&&getComputedStyle(document.querySelector('.md-math-toolbar')).display==='none'`),
  { eval: `${E}.setText(${JSON.stringify(formula)});${E}.root.focus();` },
  { cmd: "edit.find" }, { type: "search input" },
  { key: "Meta+A" }, { key: "Backspace" },
  check("Select All in a search field does not delete the document", `document.querySelector('#search-panel-input').value===''&&${E}.getMarkdown()===${JSON.stringify(formula)}`),
  { cmd: "edit.find" }, { click: "#search-panel-close" },
  { eval: `${E}.setText(${JSON.stringify("```js\nconst x=1;\n```")});${E}.root.focus();` },
  { hover: "[mdtype=fences]" }, { click: ".md-lang-input" },
  { key: "Meta+A" }, { type: "python" }, { key: "Enter" },
  check("Select All in the code-language input stays inside that input", `${E}.blocks[0].type==='code'&&${E}.blocks[0].info==='python'&&${E}.blocks[0].body==='const x=1;'`),
  check("no renderer errors", "window.__selectionErrors", []),
);
for (const [name, source, cursor, expected] of [
  ["single-line formula", "$$\nx^2\n$$\n\n", { line: 0, ch: 3 }, "$$\nx^2\n$$\n\n"],
  ["last-line start before an existing paragraph", formula + "\n\nAfter", { line: 0, ch: 0 }, formula + "\n\nAfter"],
  ["empty formula", "$$\n\n$$\n\n", { line: 0, ch: 0 }, "$$\n\n$$\n\n"],
  ["formula at the document end", formula, { line: 0, ch: 11 }, formula + "\n\n"],
  ["unclosed formula", "$$\nx+y", { line: 0, ch: 3 }, "$$\nx+y\n$$\n\n"],
  ["formula before a heading", formula + "\n\n# After", { line: 0, ch: 3 }, formula + "\n\n# After"],
]) {
  steps.push(
    { eval: `${E}.setText(${JSON.stringify(source)});${E}.root.focus();document.querySelector('[mdtype=math_block]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))` },
    { waitFor: "!!document.querySelector('[mdtype=math_block]')?.__cm" },
    { eval: `document.querySelector('[mdtype=math_block]').__cm.setCursor(${JSON.stringify(cursor)})` },
    { key: "ArrowDown" },
    check(`${name}: Down exits math with the exact delimiters and following content`, `${E}.getMarkdown()`, expected),
    check(`${name}: Down focuses the next block and hides the math source`, `!document.querySelector('[mdtype=math_block]').__cm&&!document.querySelector('[mdtype=math_block]').classList.contains('md-focus')&&document.activeElement===${E}.root&&${E}.caretInfo().blockIndex===1`),
  );
}
const multiline = "$$\na+b\nc+d\n$$\n\n";
steps.push(
  { eval: `${E}.setText(${JSON.stringify(multiline)});${E}.root.focus();document.querySelector('[mdtype=math_block]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))` },
  { waitFor: "!!document.querySelector('[mdtype=math_block]')?.__cm" },
  { eval: "document.querySelector('[mdtype=math_block]').__cm.setCursor(0,1)" },
  { key: "ArrowDown" },
  check("Down inside multiline TeX moves to the next line without exiting", `(()=>{const cm=document.querySelector('[mdtype=math_block]').__cm;return cm?.hasFocus()&&cm.getCursor().line===1&&${E}.getMarkdown()===${JSON.stringify(multiline)};})()`),
  { eval: "document.querySelector('[mdtype=math_block]').__cm.setCursor(0,1)" },
  { key: "Shift+ArrowDown" },
  check("Shift-Down extends the TeX selection without leaving math", "(()=>{const cm=document.querySelector('[mdtype=math_block]').__cm;return cm?.hasFocus()&&cm.somethingSelected()&&cm.getCursor('head').line===1;})()"),
  { key: "ArrowDown" },
  check("Down with selected TeX first collapses the selection inside math", "(()=>{const cm=document.querySelector('[mdtype=math_block]').__cm;return cm?.hasFocus()&&!cm.somethingSelected();})()"),
  { key: "ArrowDown" },
  check("Down from the last TeX line exits the multiline formula", `${E}.getMarkdown()===${JSON.stringify(multiline)}&&!document.querySelector('[mdtype=math_block]').__cm&&${E}.caretInfo().blockIndex===1`),
  { type: "After" },
  check("typing after Down stays in the following paragraph", `${E}.getMarkdown()`, multiline + "After"),
  { key: "Meta+Z" },
  check("typing after Down can be undone without changing the formula", `${E}.getMarkdown()`, multiline),
);
const wrappedTeX = "x + ".repeat(55) + "y", wrapped = "$$\n" + wrappedTeX + "\n$$\n\n";
steps.push(
  { eval: `${E}.setText(${JSON.stringify(wrapped)});${E}.root.focus();document.querySelector('[mdtype=math_block]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))` },
  { waitFor: "!!document.querySelector('[mdtype=math_block]')?.__cm" },
  { eval: "document.querySelector('[mdtype=math_block]').__cm.setCursor(0,0)" },
  check("the long TeX fixture wraps onto multiple visible lines", "(()=>{const cm=document.querySelector('[mdtype=math_block]').__cm;return cm.charCoords({line:0,ch:cm.getValue().length},'window').top>cm.charCoords({line:0,ch:0},'window').bottom;})()"),
  { key: "ArrowDown" },
  check("Down within a wrapped TeX line navigates without exiting", "(()=>{const cm=document.querySelector('[mdtype=math_block]').__cm;return cm?.hasFocus()&&cm.getCursor().line===0&&cm.getCursor().ch>0;})()"),
  { eval: "const cm=document.querySelector('[mdtype=math_block]').__cm;cm.setCursor(0,cm.getValue().length)" },
  { key: "ArrowDown" },
  check("Down on the final wrapped line exits without changing the TeX", `${E}.getMarkdown()===${JSON.stringify(wrapped)}&&!document.querySelector('[mdtype=math_block]').__cm&&${E}.caretInfo().blockIndex===1`),
  { eval: `${E}.setText(${JSON.stringify(formula + "\n\nAfter")});${E}.root.focus();document.querySelector('[mdtype=math_block]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))` },
  { waitFor: "!!document.querySelector('[mdtype=math_block]')?.__cm" },
  { eval: "document.querySelector('[mdtype=math_block]').__cm.getInputField().dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'n'}))" },
  { key: "ArrowDown" },
  check("Down during composition keeps the formula editor mounted", `${E}.getMarkdown()===${JSON.stringify(formula + "\n\nAfter")}&&!!document.querySelector('[mdtype=math_block]').__cm`),
  { eval: "document.querySelector('[mdtype=math_block]').__cm.getInputField().dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:''}))" },
  { eval: `${E}.setReadOnly(true)` },
  { key: "ArrowDown" },
  check("Down in readonly math does not close or modify the formula", `${E}.getMarkdown()===${JSON.stringify(formula + "\n\nAfter")}&&!!document.querySelector('[mdtype=math_block]').__cm`),
  { eval: `${E}.setReadOnly(false)` },
  check("math navigation produces no renderer errors", "window.__selectionErrors", []),
);
const scenario = path.join(directory, "scenario.json"); await writeFile(scenario, JSON.stringify(steps, null, 2));
const { executable, args: runtimeArgs } = await resolveRuntime(root, process.argv[2]);
const child = spawn(executable,
  [...runtimeArgs, `--user-data-dir=${profile}`, "--lettrine-harness", scenario, "--lettrine-out", directory], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; child.stdout.on("data", (data) => log += data); child.stderr.on("data", (data) => log += data);
const timeout = setTimeout(() => child.kill("SIGTERM"), 60000);
const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }); clearTimeout(timeout);
await writeFile(path.join(directory, "native.log"), log); console.log("Math selection report: " + directory);
const report = JSON.parse(await readFile(path.join(directory, "report.json"), "utf8"));
for (const result of report.filter((item) => item.op === "assert" || item.ok === false)) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name || result.error}`);
assert.equal(code, 0, "Native math selection/deletion regression failed");
