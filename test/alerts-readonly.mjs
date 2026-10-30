// Alerts, underline, readonly mode and Markdown file types in real WebKit, using an isolated profile.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { resolveRuntime } from "./runtime.mjs";
import { MARKDOWN_EXTENSIONS } from "../src/core/documents.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(path.join(os.tmpdir(), "lettrine-alerts-readonly-"));
const docs = path.join(dir, "docs"), profile = path.join(dir, "profile");
await mkdir(docs); await mkdir(profile);
await writeFile(path.join(profile, "settings.json"), JSON.stringify({ background: "light", autosave: false, locale: "en" }));
for (const extension of MARKDOWN_EXTENSIONS) await writeFile(path.join(docs, "fixture." + extension), "Selected word\n\n> [!WARNING]\n> Keep **source** unchanged.\n");
const initial = path.join(docs, "fixture.mmd"), qmd = path.join(docs, "fixture.qmd");
const A = "window.__lettrine", E = `${A}.editor`;
const check = (name, expr, eq = true) => ({ assert: { name, expr, eq } });
const blockedPath = path.join(docs, "blocked.md");
const steps = [
  { focusWindow: true },
  { waitFor: `${A}.file===${JSON.stringify(initial)}` },
  check("command-line launch recognizes .mmd documents", `${E}.getMarkdown().startsWith('Selected word')`),
  { eval: `${A}.openFolder(${JSON.stringify(docs)})` },
  check("the library indexes every registered Markdown suffix", `(async()=>{const files=await window.bridge.library.listDocsUnder({path:${JSON.stringify(docs)}});return ${JSON.stringify(MARKDOWN_EXTENSIONS)}.every(ext=>files.some(file=>file.name==='fixture.'+ext));})()`),
  check("Quick Open finds .qmd files", `(async()=>{const files=await window.bridge.quickOpen.query({scope:${JSON.stringify(docs)},text:'fixture.qmd'});return files.some(file=>file.path===${JSON.stringify(qmd)});})()`),
  { eval: `${E}.root.focus();${E}.selectOffsets(9,13)` },
  { key: "Meta+Shift+U" },
  check("the native Underline shortcut wraps the selected word", `${E}.getMarkdown().startsWith('Selected <u>word</u>')&&!!${E}.root.querySelector('u')`),
  { key: "Meta+Shift+U" },
  check("the same native shortcut unwraps its inner selection", `${E}.getMarkdown().startsWith('Selected word')`),
  { eval: `${E}.selectOffsets(9,13)` },
  { key: "Meta+Shift+U" },
  { eval: `${E}.placeCaret(1,${E}.blocks[1].src.length)` },
  { cmd: "paragraph.alert.tip" },
  check("the Alert menu changes an existing quote without losing its body", `!!${E}.root.querySelector('.md-alert-tip strong')&&${E}.getMarkdown().includes('> [!TIP]')`),
  { type: " Edited." },
  check("typing in an alert preserves its marker", `${E}.getMarkdown().includes('> [!TIP]')&&${E}.getMarkdown().includes('Edited.')`),
  { capture: "alert-light" },
  { eval: `${A}.setTheme('lettrine-dark')` },
  { waitFor: `getComputedStyle(${E}.root.querySelector('.md-alert-tip')).getPropertyValue('--alert-color').trim()==='#56d381'` },
  { capture: "alert-dark" },
  { eval: `${A}.setTheme('lettrine')` },
  { eval: `${E}.root.focus();${E}.selectOffsets(9,13);window.__beforeReadonly=${E}.getMarkdown();window.__readonlyHistory=${E}._history.length` },
  { key: "Meta+Alt+R" },
  check("Readonly Mode hides the modified indicator but retains the unsaved draft", `${E}.readOnly&&${A}._dirty&&!document.title.includes('●')&&document.querySelector('#titlebar-document-status').textContent==='Readonly Mode'`),
  { type: "blocked" }, { key: "Backspace" }, { cmd: "inline.strong" }, { cmd: "paragraph.alert.caution" },
  { eval: "window.bridge.clipboard.write({text:'blocked paste'})" },
  { key: "Meta+V" }, { cmd: "edit.undo" }, { cmd: "file.save" },
  check("typing, deletion, formatting, paste, undo and save leave a readonly draft intact", `${E}.getMarkdown()===__beforeReadonly&&${E}._history.length===__readonlyHistory`),
  check("the native host also rejects readonly file writes", `(async()=>{try{await window.bridge.document.write({path:${JSON.stringify(initial)},text:'blocked'});return false;}catch(error){return error.message.includes('Readonly');}})()`),
  check("the native host rejects readonly file creation", `(async()=>{try{await window.bridge.library.newFile({path:${JSON.stringify(blockedPath)}});return false;}catch(error){return error.message.includes('Readonly');}})()`),
  { capture: "readonly" },
  { key: "Meta+Alt+R" },
  check("leaving readonly restores the selection and modified indicator", `${E}.selectionOffsets().start===9&&${E}.selectionOffsets().end===13&&document.title.includes('●')`),
  { key: "Meta+Z" },
  check("Undo remains available after readonly", `${E}.getMarkdown()!==__beforeReadonly`),
  { eval: `${A}._dirty=false` },
  { open: qmd },
  check(".qmd opens as a Markdown document with a rendered alert", `${A}.file===${JSON.stringify(qmd)}&&!!${E}.root.querySelector('.md-alert-warning')`),
  { cmd: "view.source" }, { waitFor: `!!${A}._sourceCM` },
  { eval: `${A}._sourceCM.setCursor({line:0,ch:8});${A}._sourceCM.focus();window.__sourceBeforeReadonly=${A}._sourceCM.getValue()` },
  { key: "Meta+Alt+R" }, { type: "blocked" }, { key: "Meta+V" },
  check("source CodeMirror also becomes readonly", `${A}._sourceCM.getOption('readOnly')===true&&${A}._sourceCM.getValue()===__sourceBeforeReadonly`),
  { key: "Meta+Alt+R" },
  check("leaving readonly restores the source cursor", `${A}._sourceCM.getOption('readOnly')===false&&${A}._sourceCM.getCursor().ch===8`),
  { cmd: "view.source" },
  { eval: `${E}.setText(${JSON.stringify("```js\nconst value = 1;\n```\n\n- [ ] task\n\n[^n]: note")});${E}.root.focus();document.querySelector('[mdtype=fences]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))` },
  { waitFor: "!!document.querySelector('[mdtype=fences]').__cm" },
  { eval: "window.__code=document.querySelector('[mdtype=fences]').__cm;__code.setCursor({line:0,ch:6});__code.focus()" },
  { key: "Meta+Alt+R" }, { type: "blocked" },
  check("mounted code, task boxes and editable footnotes become readonly", `__code.getOption('readOnly')===true&&__code.getValue()==='const value = 1;'&&document.querySelector('input[type=checkbox]').disabled&&!${E}.root.querySelector('[contenteditable=true]')`),
  { key: "Meta+Alt+R" },
  check("leaving readonly restores the mounted code cursor and controls", "__code.hasFocus()&&__code.getCursor().ch===6&&!document.querySelector('input[type=checkbox]').disabled"),
  { type: "restored" },
  check("typing in code resumes after readonly", "__code.getValue().includes('restored')"),
];

const scenario = path.join(dir, "scenario.json"); await writeFile(scenario, JSON.stringify(steps, null, 2));
const { executable, args } = await resolveRuntime(root, process.argv[2]);
const bundle = path.dirname(path.dirname(executable));
const plistResult = spawnSync("plutil", ["-convert", "json", "-o", "-", path.join(bundle, "Info.plist")], { encoding: "utf8" });
assert.equal(plistResult.status, 0);
const plist = JSON.parse(plistResult.stdout), markdown = plist.CFBundleDocumentTypes.find(type => type.CFBundleTypeName === "Markdown document");
assert.deepEqual(markdown.CFBundleTypeExtensions, MARKDOWN_EXTENSIONS);
assert.ok(markdown.LSItemContentTypes.includes("net.daringfireball.markdown") && markdown.LSItemContentTypes.includes("io.typora.markdown"));
assert.equal(plist.CFBundleDocumentTypes.find(type => type.CFBundleTypeName === "Plain text document").LSHandlerRank, "Alternate");
const child = spawn(executable, [...args, initial, "--user-data-dir=" + profile, "--lettrine-harness", scenario, "--lettrine-out", dir], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; child.stdout.on("data", data => { log += data; }); child.stderr.on("data", data => { log += data; });
const timeout = setTimeout(() => child.kill("SIGTERM"), 90000);
const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }); clearTimeout(timeout);
await writeFile(path.join(dir, "native.log"), log); console.log("Alerts and readonly native report: " + dir);
const report = JSON.parse(await readFile(path.join(dir, "report.json"), "utf8"));
for (const item of report.filter(item => item.op === "assert" || item.ok === false)) console.log(`${item.ok ? "PASS" : "FAIL"} ${item.name || item.error}`);
assert.equal(code, 0, "Alerts and readonly native scenarios failed");
assert.match(await readFile(initial, "utf8"), /^Selected word\n/);
assert.equal((await readFile(qmd, "utf8")).includes("blocked"), false);
