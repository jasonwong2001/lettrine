import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { resolveRuntime } from "./runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), dir = await mkdtemp(path.join(os.tmpdir(), "lettrine-document-toolbar-")), profile = path.join(dir, "profile");
await mkdir(profile); await writeFile(path.join(profile, "settings.json"), JSON.stringify({ autosave: false, locale: "en", welcomeShown: true, background: "light" }));
const source = "alpha omega", doc = path.join(dir, "toolbar.md"); await writeFile(doc, source);
const A = "window.__lettrine", E = A + ".editor", q = JSON.stringify;
const check = (name, expr, eq = true) => ({ assert: { name, expr, eq } });
const reset = text => ({ eval: `${E}.setText(${q(text)});${E}.root.focus();${E}.selectOffsets(${text.length});${A}._savedText=${E}.getMarkdown();${E}.emit()` });
const button = command => `#document-toolbar [data-command="${command}"]`;
const click = command => ({ click: button(command) });
const { executable, args } = await resolveRuntime(root, process.argv[2]);
async function run(steps, suffix) {
  const output = path.join(dir, suffix); await mkdir(output);
  const scenario = path.join(output, "scenario.json"); await writeFile(scenario, JSON.stringify(steps, null, 2));
  const child = spawn(executable, [...args, "--user-data-dir=" + profile, "--lettrine-harness", scenario, "--lettrine-out", output], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", data => { log += data; }); child.stderr.on("data", data => { log += data; });
  const timer = setTimeout(() => child.kill("SIGTERM"), 120000);
  const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }); clearTimeout(timer);
  await writeFile(path.join(output, "native.log"), log);
  const report = JSON.parse(await readFile(path.join(output, "report.json"), "utf8"));
  for (const item of report.filter(item => item.op === "assert" || item.ok === false)) console.log(`${item.ok ? "PASS" : "FAIL"} ${item.name || item.error}`);
  assert.equal(code, 0, "Native document toolbar failed: " + suffix); assert.ok(report.every(item => item.ok));
}
console.log("Document toolbar report: " + dir);
await run([
  { open: doc }, check("the optional toolbar starts hidden", "document.getElementById('document-toolbar').hidden"),
  { eval: `${E}.root.focus();${E}.selectOffsets(0,5)` }, { cmd: "view.toolbar" },
  check("showing the toolbar preserves the document and selection", `${E}.getMarkdown()===${q(source)}&&${E}._history.length===1&&${E}.selectionOffsets().start===0&&${E}.selectionOffsets().end===5`),
  click("inline.strong"),
  check("a native pointer click formats the retained selection", `${E}.getMarkdown()`, "**alpha** omega"),
  { key: "Meta+Z" }, check("toolbar formatting is independently undoable", `${E}.getMarkdown()`, source),
  { eval: "(()=>{const popup=window.bridge.menu.popup;window.bridge.menu.popup=async p=>{window.bridge.menu.popup=popup;return {id:p.items.find(item=>item.label==='Heading 2').id};};})()" },
  { click: "#toolbar-headings" },
  check("the heading menu reuses the existing heading command", `${E}.getMarkdown()`, "## alpha omega"),
  { key: "Meta+Z" },
  click("paragraph.unorderedList"), check("toolbar list commands use the current block", `${E}.getMarkdown()`, "- alpha omega"),
  { key: "Meta+Z" },
  reset("First\n\nSecond"), { eval: `${E}.selectOffsets(2)` }, click("paragraph.table"),
  { eval: "document.getElementById('table-insert-col').value='2';document.getElementById('table-insert-row').value='2'" }, { key: "Enter" },
  { waitFor: `${E}.blocks.some(block=>block.type==='table')` },
  check("table insertion retains its intended block across the native modal focus change", `${E}.blocks[0].src==='First'&&${E}.blocks[1].type==='table'&&${E}.blocks.at(-1).src==='Second'`),
  { key: "Meta+Z" }, check("table insertion has one undo step", `${E}.getMarkdown()`, "First\n\nSecond"),
  reset("x^2"), click("paragraph.mathBlock"), check("the math button invokes the existing block conversion", `${E}.getMarkdown()`, "$$\nx^2\n$$"),
  { key: "Meta+Z" },
  reset("const value = 1;"), click("paragraph.codeFences"),
  check("the code button creates an editable code fence", `${E}.blocks[0].type==='code'&&${E}.blocks[0].body==='const value = 1;'`),
  { key: "Meta+Z" },
  reset("word"), { eval: `${E}.selectOffsets(0,4)` }, click("inline.link"),
  { eval: "document.getElementById('link-url').value='https://example.com'" }, { key: "Enter" },
  { waitFor: "!document.getElementById('link-dialog')" },
  check("the link dialog retains selected link text", `${E}.getMarkdown()`, "[word](https://example.com)"),
  { key: "Meta+Z" },
  { eval: "(()=>{const choose=window.bridge.images.import;window.bridge.images.import=async()=>{window.bridge.images.import=choose;return {reference:'assets/local.png'};};})()" },
  click("inline.image"),
  check("the image button reuses the native image import result", `${E}.getMarkdown().includes('![](assets/local.png)')`),
  { key: "Meta+Z" },
  reset("# Heading\n\nTail"), click("paragraph.toc"),
  check("the TOC button inserts source-preserving Markdown", `${E}.getMarkdown()`, "# Heading\n\nTail\n\n[TOC]"),
  { key: "Meta+Z" },
  reset("base"), { cmd: "view.source" }, { waitFor: `!!${A}._sourceCM` }, { type: " tail" },
  { eval: `${A}._sourceCM.setSelection({line:0,ch:5},{line:0,ch:9})` }, click("inline.strong"),
  check("toolbar formatting works through the actual Source Code Mode editor", `${A}._sourceCM.getValue()`, "base **tail**"),
  { key: "Meta+Z" }, check("Source Code Mode undoes formatting independently", `${A}._sourceCM.getValue()`, "base tail"),
  { key: "Meta+Z" }, check("source formatting retains the preceding native typing history", `${A}._sourceCM.getValue()`, "base"),
  { eval: `${A}._sourceCM.setCursor({line:0,ch:4})` }, click("paragraph.table"),
  { eval: "document.getElementById('table-insert-col').value='2';document.getElementById('table-insert-row').value='2'" }, { key: "Enter" },
  { waitFor: `${A}._sourceCM.getValue().includes('| Column 1 | Column 2 |')` },
  check("table dialogs update the source editor and its document model together", `${A}._sourceCM.getValue()===${E}.getMarkdown()`),
  { key: "Meta+Z" }, check("source table insertion preserves its undo stack", `${A}._sourceCM.getValue()`, "base"),
  { cmd: "view.readonly" },
  check("readonly disables every editing button while retaining the hide control", "[...document.querySelectorAll('#document-toolbar .ui-toolbar-edit')].every(button=>button.disabled)&&!document.querySelector('#document-toolbar .ui-toolbar-dismiss').disabled"),
  { type: "blocked" }, check("readonly source remains unchanged", `${A}._sourceCM.getValue()`, "base"),
  { cmd: "view.readonly" }, { cmd: "view.source" },
  { eval: "document.getElementById('toolbar-headings').focus()" }, { key: "ArrowRight" },
  check("native arrow keys navigate the toolbar", "document.activeElement.dataset.command", "inline.strong"),
  { eval: "window.bridge.i18n.setLocale({locale:'zh-Hans'})" }, { waitFor: `${A}.i18n.locale==='zh-Hans'` },
  check("toolbar labels and TOC text are localized", `document.getElementById('document-toolbar').getAttribute('aria-label')==='文档工具栏'&&document.querySelector(${q(button("paragraph.toc"))}).textContent==='目录'`),
  { capture: "toolbar-light" },
  { eval: "window.bridge.setting.put({key:'__patch',value:{background:'dark'}})" }, { waitFor: "document.body.classList.contains('ui-dark')" },
  { capture: "toolbar-dark" },
  { window: "new" },
  check("new windows inherit toolbar visibility", "!document.getElementById('document-toolbar').hidden"),
  { tab: "close" },
  check("toolbar controls leave no startup errors", "window.__lettrineStartupErrors", []),
], "editing");
await run([
  check("toolbar visibility survives an actual application restart", `${A}.settings.showDocumentToolbar&&!document.getElementById('document-toolbar').hidden`),
  { cmd: "view.toolbar" }, check("the toolbar can still be hidden after restarting", "document.getElementById('document-toolbar').hidden"),
], "relaunch");
assert.equal(await readFile(doc, "utf8"), source);
console.log("PASS optional persistent toolbar, native pointer/keyboard controls, reused formatting and insertion commands, source undo preservation, readonly, localization and themes");
