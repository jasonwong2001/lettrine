import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { resolveRuntime } from "./runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(path.join(os.tmpdir(), "lettrine-settings-breadth-")), profile = path.join(dir, "profile"), library = path.join(dir, "library"), pinned = path.join(dir, "pinned");
for (const folder of [profile, library, pinned, path.join(library, ".hidden"), path.join(library, ".git")]) await mkdir(folder, { recursive: true });
await writeFile(path.join(profile, "settings.json"), JSON.stringify({ autosave: false, locale: "en", background: "light" }));
for (const name of [".secret.md", ".hidden/note.md", ".git/private.md"]) await writeFile(path.join(library, name), "Hidden document");
const source = "# First<br/>line\n\nBody<BR />next\n\n## \n\n> \n\n```js\nconst longLine = \"" + "long".repeat(160) + "\";\n```\n\nTail";
const doc = path.join(library, "settings.md"), other = path.join(library, "other.md"), output = path.join(dir, "chosen.qmd");
await writeFile(doc, source); await writeFile(other, "Other document");
const A = "window.__lettrine", E = `${A}.editor`, q = JSON.stringify;
const check = (name, expr, eq = true) => ({ assert: { name, expr, eq } });
const setting = (patch) => ({ eval: `window.bridge.setting.put({key:'__patch',value:${q(patch)}})` });
const reset = (text) => ({ eval: `${E}.root.focus();${E}.setText(${q(text)});${E}.selectOffsets(${text.length});${A}._savedText=${E}.getMarkdown();${E}.emit()` });
const bools = ["autoPairMarkdown", "autoExpandSimple", "hideBreakMarkers", "ignoreHeadingBreaks", "indentFirstLine", "showHiddenFiles", "saveOnSwitch", "quitAfterLastWindow"];
const steps = [
  { open: doc }, { eval: `${A}.openFolder(${q(library)})` },
  check("hidden documents are absent by default", `!${A}.files.some(f=>f.name.startsWith('.'))&&!${A}.files.some(f=>f.path.includes('/.hidden/'))`),
  { cmd: "file.preferences" },
  check("line-ending and final-newline controls are exposed with preserving defaults", "document.getElementById('pref-line-endings').value===''&&!document.getElementById('pref-final-newline').checked"),
  { eval: `${q(bools)}.forEach(k=>document.getElementById('pref-extra-'+k).checked=true);document.getElementById('pref-extra-wrapCode').checked=false;document.getElementById('pref-extra-defaultExtension').value='qmd';document.getElementById('pref-extra-defaultCodeLanguage').value='python';document.getElementById('pref-extra-pinnedFolders').value=${q(pinned + "\n" + library + "\n" + pinned)};document.getElementById('preferences-done').click()` },
  { waitFor: `${A}.settings.showHiddenFiles===true&&${A}.settings.wrapCode===false&&${A}.files.some(f=>f.path.includes('/.hidden/note.md'))` },
  check("all display settings apply without changing Markdown or document history", `${E}.getMarkdown()===${q(source)}&&!${A}._dirty&&${E}._history.length===1&&${A}.settings.pinnedFolders.length===2`),
  check("hidden-file indexing includes hidden documents while still excluding repository internals", `${A}.files.some(f=>f.name==='.secret.md')&&!${A}.files.some(f=>f.path.includes('/.git/'))`),
  check("paragraph indent, hidden break markers and single-line headings apply immediately", `getComputedStyle(${E}.root.querySelector('p')).textIndent!=='0px'&&getComputedStyle(${E}.root.querySelector('.md-html-br')).display==='none'&&!${E}.root.querySelector('h1 br')&&getComputedStyle(${E}.root.querySelector('h1')).whiteSpace==='normal'`),
  { eval: `${E}.root.querySelector('pre.md-fences').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))` },
  { waitFor: `!!${E}.root.querySelector('pre.md-fences').__cm` },
  check("long code lines use horizontal scrolling in the mounted editor", `${E}.root.querySelector('pre.md-fences').__cm.getOption('lineWrapping')===false&&${E}.root.querySelector('pre.md-fences .CodeMirror-sizer').scrollWidth>1000`),
  { eval: `${E}.root.focus();${E}.selectOffsets(${source.indexOf("## ") + 3})` },
  { waitFor: `!!${E}.root.querySelector('h2.md-simple-focus')` },
  { eval: `${E}.selectOffsets(${source.indexOf("> ") + 2})` },
  { waitFor: `!!${E}.root.querySelector('blockquote.md-simple-focus .md-simple-marker')` },
  setting({ autoExpandSimple: false }), { waitFor: `!${E}.root.querySelector('.md-simple-focus')` },
  check("turning empty-block expansion off retains exact source", `${E}.getMarkdown()`, source),
  setting({ autoExpandSimple: true, saveOnSwitch: false }),
  reset(""), { type: "*em*" },
  check("real native typing completes emphasis without duplicate delimiters", `${E}.getMarkdown()`, "*em*"),
  { key: "Meta+Z" }, { key: "Meta+Z" },
  check("generated markers and typed text can both be undone", `${E}.getMarkdown()`, ""),
  reset(""), { type: "## Heading" },
  check("heading completion avoids duplicating the typed separator", `${E}.getMarkdown()`, "## Heading"),
  reset(""), { type: "> Quote" },
  check("empty quotes have a real editing anchor after completion", `${E}.getMarkdown()`, "> Quote"),
  reset(""), { type: "```" },
  check("fence markers retain an editable default language until Enter", `${E}.getMarkdown()`, "```python"),
  { key: "Enter" }, { waitFor: `!!${E}.root.querySelector('pre.md-fences').__cm` },
  { type: "value = 1" },
  check("Enter completes a closed fence and native input edits its body", `${E}.getMarkdown()`, "```python\nvalue = 1\n```"),
  { key: "Meta+Z" },
  check("fence-body edits undo independently of completion", `${E}.getMarkdown()`, "```python\n\n```"),
  reset(""), { cmd: "view.source" }, { waitFor: `!!${A}._sourceCM` },
  { type: "*em*" },
  check("Markdown completion also works through the real source editor", `${A}._sourceCM.getValue()`, "*em*"),
  { cmd: "view.readonly" }, { type: "blocked" },
  check("readonly guards source completion and input", `${A}._sourceCM.getValue()`, "*em*"),
  { cmd: "view.readonly" }, { cmd: "view.source" },
  reset("final line"), { type: "!" },
  setting({ finalNewLine: true }),
  { eval: `(()=>{const save=window.bridge.window.save;window.bridge.window.save=p=>{window.bridge.window.save=save;return save({...p,defaultPath:${q(output)}})};})()` },
  { saveDialog: { path: output, lineEndings: "CRLF" } },
  { waitFor: `${A}.file===${q(output)}&&!${A}._dirty`, diagnostic: `({file:${A}.file,dirty:${A}._dirty,text:${E}.getMarkdown(),errors:window.__lettrineStartupErrors})` },
  check("the native save panel applies its per-save line-ending choice", `(async()=>{const f=await window.bridge.document.read({path:${q(output)}});return f.text==='final line!\\r\\n'&&${A}.settings.lineEndings==='';})()`),
  { key: "Meta+Z" },
  check("final-newline insertion on save is a separate undoable edit", `${E}.getMarkdown()`, "final line!"),
  { cmd: "format.lf" }, { save: true },
  check("document-only line-ending commands affect the next save", `(async()=>{const f=await window.bridge.document.read({path:${q(output)}});return f.text==='final line!\\n'&&${A}.settings.lineEndings==='';})()`),
  setting({ saveOnSwitch: true, finalNewLine: false }),
  { eval: `${E}.root.focus();${E}.replaceRange(${E}.getMarkdown().length-1,${E}.getMarkdown().length-1,' revised')` },
  { open: other },
  check("switching documents saves the departing draft", `(async()=>{const f=await window.bridge.document.read({path:${q(output)}});return f.text==='final line! revised\\n'&&${A}.file===${q(other)};})()`),
  { eval: `${E}.replaceRange(${E}.getMarkdown().length,${E}.getMarkdown().length,' saved on window switch')` },
  { window: "new" },
  { waitFor: `(async()=>{const f=await window.bridge.document.read({path:${q(other)}});return f.text==='Other document saved on window switch';})()` },
  check("new windows retain the default extension, pinned folders and display preferences", `${A}.settings.defaultExtension==='qmd'&&${A}.settings.wrapCode===false&&${A}.settings.pinnedFolders.length===2`),
  { tab: "close" },
  { waitFor: `${A}.file===${q(other)}` },
  { eval: "window.bridge.i18n.setLocale({locale:'zh-Hans'})" }, { waitFor: `${A}.i18n.locale==='zh-Hans'` },
  { cmd: "file.preferences" },
  check("new settings are translated and retain their values", "document.querySelector('#pref-extra-autoPairMarkdown+span').textContent==='自动补全 Markdown 标记'&&document.getElementById('pref-extra-autoPairMarkdown').checked&&!document.getElementById('pref-extra-wrapCode').checked"),
  { eval: "document.getElementById('preferences-done').click()" },
  setting({ background: "dark" }), { waitFor: "document.body.classList.contains('ui-dark')" },
  { capture: "settings-dark" },
  check("settings and native editing leave no startup errors", "window.__lettrineStartupErrors", []),
  { closeLastWindow: true },
];
const { executable, args } = await resolveRuntime(root, process.argv[2]);
async function run(steps, suffix) {
  const outputDir = path.join(dir, suffix); await mkdir(outputDir);
  const scenario = path.join(outputDir, "scenario.json"); await writeFile(scenario, JSON.stringify(steps, null, 2));
  const child = spawn(executable, [...args, "--user-data-dir=" + profile, "--lettrine-trace", "--lettrine-harness", scenario, "--lettrine-out", outputDir], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let log = ""; child.stdout.on("data", (data) => { log += data; }); child.stderr.on("data", (data) => { log += data; process.stdout.write(data); });
  const timer = setTimeout(() => child.kill("SIGTERM"), 180000);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }); }
  finally { clearTimeout(timer); }
  await writeFile(path.join(outputDir, "native.log"), log);
  const report = JSON.parse(await readFile(path.join(outputDir, "report.json"), "utf8"));
  for (const item of report.filter((item) => item.op === "assert" || item.ok === false)) console.log(`${item.ok ? "PASS" : "FAIL"} ${item.name || item.error}`);
  assert.equal(code, 0, "Native settings scenario failed: " + suffix); assert.ok(report.every((item) => item.ok));
  return report;
}
console.log("Settings breadth report: " + dir);
await run(steps, "editing");
const stored = JSON.parse(await readFile(path.join(profile, "settings.json"), "utf8"));
for (const key of bools) assert.equal(stored[key], true, key);
assert.equal(stored.wrapCode, false); assert.equal(stored.defaultExtension, "qmd"); assert.deepEqual(stored.pinnedFolders, [pinned, library]);
await run([
  check("settings survive an actual application restart", `${q(bools)}.every(k=>${A}.settings[k]===true)&&${A}.settings.wrapCode===false&&${A}.settings.defaultExtension==='qmd'&&${A}.settings.pinnedFolders.length===2`),
  { closeLastWindow: true },
], "relaunch");
assert.equal(await readFile(doc, "utf8"), source);
console.log("PASS persistent settings, source-safe native typing, file defaults, real save-panel line endings, undoable newline, hidden files, window-switch saving, readonly, localization and quit after last window");
