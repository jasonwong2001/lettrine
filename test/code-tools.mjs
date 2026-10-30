import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { resolveRuntime } from "./runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(path.join(os.tmpdir(), "lettrine-code-")), profile = path.join(dir, "profile");
await mkdir(profile);
await writeFile(path.join(profile, "settings.json"), JSON.stringify({ autosave: false, locale: "en", background: "light" }));
const js = 'function greet(name) {\nconsole.log(name);   \nif (name) {\nconsole.log("ready");\n}\n}';
const prettyJS = 'function greet(name) {\n  console.log(name);\n  if (name) {\n    console.log("ready");\n  }\n}';
const source = "# Code tools\n\n````javascript\n" + js + "\n``````  \n\nTail stays  \n\n~~~json\n{\n\"items\": [\n1,\n2\n]\n}\n~~~";
const prettySource = source.replace(js, prettyJS), selectedSource = source.replace("console.log(name);   ", "  console.log(name);   ");
const doc = path.join(dir, "code.md"); await writeFile(doc, source);
const A = "window.__lettrine", E = `${A}.editor`, S = `${A}._sourceCM`, q = JSON.stringify, C = `${E}.root.querySelector('pre').__cm`;
const check = (name, expr, eq = true) => ({ assert: { name, expr, eq } });
const setPreview = (text) => ({ eval: `${E}.setText(${q(text)},{docBase:${q(doc)}});${E}.root.focus();${E}.selectOffsets(0)` });
const settings = (patch) => ({ eval: `window.bridge.setting.put({key:'__patch',value:${q(patch)}})` });
const mountCode = { eval: `${E}.root.querySelector('pre').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))` };
const steps = [
  { open: doc }, { focusWindow: true },
  { assertMenu: { id: "command.code.prettify", property: "label", eq: "Prettify Source Code", name: "Format exposes code tools" } },
  { cmd: "file.preferences" },
  { eval: "document.querySelector('[data-pane=editor]').click();document.getElementById('pref-extra-codeIndentSize').value='2';document.getElementById('pref-extra-codeShiftTab').value='outdent';document.getElementById('pref-extra-defaultCodeLanguage').value='python';document.getElementById('preferences-done').click()" },
  { waitFor: `${A}.settings.codeIndentSize===2&&${A}.settings.defaultCodeLanguage==='python'` },
  check("code settings do not rewrite existing fence languages or source", `${E}.getMarkdown()`, source),
  mountCode, { waitFor: `!!${C}`, diagnostic: `({active:document.activeElement.closest('pre')?.outerHTML||document.activeElement.outerHTML,codes:[...${E}.root.querySelectorAll('pre')].map(pre=>({language:pre.dataset.info,mounted:!!pre.__cm})),code:${E}.root.querySelector('pre').outerHTML,errors:window.__lettrineStartupErrors})` },
  { eval: `window.__originalCM=${C};window.__tailBlock=${E}.root.querySelector('pre').nextElementSibling;${C}.setCursor({line:1,ch:7});${C}.focus()` },
  { cmd: "code.prettify" },
  check("prettify repairs indentation and trailing spaces while retaining exact fences and prose", `${E}.getMarkdown()`, prettySource),
  check("formatting keeps the mounted code editor and other document blocks", `${C}===__originalCM&&${E}.root.querySelector('pre').nextElementSibling===__tailBlock&&${C}.getOption('indentUnit')===2`),
  { eval: `window.__historyAfterFormat=${E}._history.length` },
  { cmd: "code.prettify" },
  check("prettify is idempotent and does not add an undo entry", `${E}.getMarkdown()===${q(prettySource)}&&${E}._history.length===__historyAfterFormat`),
  { key: "Meta+Z" },
  check("one undo restores the original code and whitespace", `${E}.getMarkdown()`, source),
  { waitFor: `!!${C}` }, { key: "Meta+Shift+Z" },
  check("redo restores the formatted code", `${E}.getMarkdown()`, prettySource),
  { waitFor: `!!${C}` },
  { eval: `${C}.setCursor({line:1,ch:2});${C}.focus()` }, { key: "Tab" },
  check("Tab uses the independent code indent size", `${C}.getLine(1)`, "    console.log(name);"),
  { key: "Shift+Tab" },
  check("Shift+Tab outdents by default", `${C}.getLine(1)`, "  console.log(name);"),
  setPreview(source), mountCode, { waitFor: `!!${C}` },
  { eval: `${C}.setSelection({line:1,ch:0},{line:2,ch:0});${C}.focus()` },
  { cmd: "code.indentSelected" },
  check("selected-code indentation excludes the next line at column zero and preserves trailing spaces", `${E}.getMarkdown()`, selectedSource),
  { key: "Meta+Z" }, { waitFor: `!!${C}` },
  settings({ codeShiftTab: "auto" }),
  { eval: `${C}.setSelection({line:1,ch:0},{line:2,ch:0});${C}.focus()` },
  { key: "Shift+Tab" },
  { waitFor: `${E}.getMarkdown()===${q(selectedSource)}` },
  check("Shift+Tab switches immediately to automatic selected-code indentation", `${C}.getLine(2)`, "if (name) {"),
  { key: "Meta+Z" }, { waitFor: `!!${C}` },
  { cmd: "code.indentWhole" },
  check("whole-code auto indent preserves trailing spaces", `${E}.getMarkdown()`, prettySource.replace("console.log(name);", "console.log(name);   ")),
  { capture: "code-light" },
  setPreview("new fence"), { eval: `${E}.selectOffsets(3)` }, { cmd: "paragraph.codeFences" },
  check("menu-created fences use the configured default language", `${E}.blocks[0].info`, "python"),
  { key: "Meta+Z" },
  check("default-language fence creation is undoable", `${E}.getMarkdown()`, "new fence"),
  setPreview(""), { type: "```" }, { sleep: 250 },
  check("typed preview fences insert and select the default language", `${E}.getMarkdown()==='\\u0060\\u0060\\u0060python'&&window.getSelection().toString()==='python'`),
  { type: "jav" }, { waitFor: "!!document.getElementById('ui-code-languages')", diagnostic: `({text:${E}.getMarkdown(),selection:${E}.selectionOffsets(),active:document.activeElement.outerHTML,errors:window.__lettrineStartupErrors})` },
  check("fence markers suggest matching languages", "[...document.querySelectorAll('#ui-code-languages button')].map(item=>item.textContent)", ["java", "javascript"]),
  { capture: "language-completion" },
  { key: "ArrowDown" }, { key: "Tab" },
  check("Tab accepts the selected fence language without inserting whitespace", `${E}.getMarkdown()`, "```javascript"),
  { key: "Enter" }, { waitFor: `!!${C}` },
  { type: "const value = 1;" }, { key: "Meta+Enter" },
  check("the completed fence remains editable and closes without another default language", `${E}.blocks[0].info==='javascript'&&${E}.blocks[0].body==='const value = 1;'&&${E}.blocks[0].closed`),
  setPreview(source), { cmd: "view.source" }, { waitFor: `!!${S}` },
  { eval: `${S}.setCursor(${S}.posFromIndex(${source.indexOf("console.log(name)")}));${S}.clearHistory();${S}.focus()` },
  { cmd: "code.prettify" },
  check("Source Code Mode formats the current fence without leaving source view", `${S}.getValue()===${q(prettySource)}&&document.body.classList.contains('sourceview-on')`),
  { key: "Meta+Z" },
  check("source formatting has a single independent undo step", `${S}.getValue()`, source),
  { key: "Meta+Shift+Z" },
  check("source formatting participates in redo", `${S}.getValue()`, prettySource),
  { eval: `${S}.setValue(${q(source)});${S}.clearHistory();${S}.setSelection(${S}.posFromIndex(${source.indexOf("console.log(name)")}),${S}.posFromIndex(${source.indexOf("if (name)")}));${S}.focus()` },
  { key: "Shift+Tab" }, { waitFor: `${S}.getValue()===${q(selectedSource)}` },
  check("source Shift+Tab uses the same selected-code rules", `${S}.getValue()`, selectedSource),
  { key: "Meta+Z" },
  settings({ codeShiftTab: "outdent" }),
  { eval: `${S}.setCursor(${S}.posFromIndex(${source.indexOf("console.log(name)")}));${S}.focus()` },
  { key: "Tab" },
  check("source Tab uses code indentation inside fences", `${S}.getValue()`, selectedSource),
  { key: "Shift+Tab" },
  check("source Shift+Tab returns to outdent without reopening the editor", `${S}.getValue()`, source),
  { eval: `${S}.setValue('');${S}.clearHistory();${S}.focus()` }, { type: "```" },
  check("source-mode typed fences also select their default language", `${S}.getValue()==='\\u0060\\u0060\\u0060python'&&${S}.getSelection()==='python'`),
  { type: "jav" }, { waitFor: "!!document.getElementById('ui-code-languages')" },
  { key: "ArrowDown" }, { key: "Enter" },
  check("source language completion accepts Enter and starts the code body", `${S}.getValue()`, "```javascript\n"),
  { eval: `${S}.setValue('\\u0060\\u0060\\u0060js\\nconst value = 1;\\n\\u0060\\u0060');${S}.setCursor({line:2,ch:2});${S}.focus()` },
  { type: "`" },
  check("typing a closing fence does not append a default language", `${S}.getValue()`, "```js\nconst value = 1;\n```"),
  { eval: `${S}.setValue(${q(source)});${S}.setCursor(${S}.posFromIndex(${source.indexOf("console.log(name)")}));${S}.focus()` },
  { cmd: "view.readonly" }, { cmd: "code.prettify" },
  check("readonly source rejects formatting", `${S}.getValue()`, source),
  { cmd: "view.readonly" }, { cmd: "view.source" },
  { eval: `${A}.setTheme('lettrine-dark')` }, { waitFor: "document.body.classList.contains('ui-dark')" },
  mountCode, { waitFor: `!!${C}` },
  { cmd: "code.prettify" }, { capture: "code-dark" },
  { cmd: "view.readonly" }, { cmd: "code.indentWhole" },
  check("readonly preview keeps the formatted source intact", `${E}.getMarkdown()`, prettySource),
  { cmd: "view.readonly" },
  { eval: "window.bridge.i18n.setLocale({locale:'zh-Hans'})" }, { waitFor: `${A}.i18n.locale==='zh-Hans'` },
  { assertMenu: { id: "command.code.indentWhole", property: "label", eq: "自动缩进整段代码", name: "code tools have Simplified Chinese labels" } },
  check("existing fence language controls follow the interface language", `${E}.root.querySelector('.md-lang-input').getAttribute('aria-label')`, "代码语言"),
  { cmd: "file.preferences" }, { eval: "document.querySelector('[data-pane=editor]').click()" },
  check("code preferences are localized and retain their values", "document.getElementById('pref-extra-codeIndentSize').value==='2'&&document.getElementById('pref-extra-defaultCodeLanguage').value==='python'&&document.querySelector('[data-pref-group=editor-code]').textContent.includes('代码缩进大小')"),
  { click: "#preferences-done" },
  { eval: "window.bridge.i18n.setLocale({locale:'zh-Hant'})" }, { waitFor: `${A}.i18n.locale==='zh-Hant'` },
  { assertMenu: { id: "command.code.prettify", property: "label", eq: "整理程式碼", name: "code tools have Traditional Chinese labels" } },
  check("existing fence language controls switch languages again", `${E}.root.querySelector('.md-lang-input').getAttribute('aria-label')`, "程式碼語言"),
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
await writeFile(path.join(dir, "native.log"), log); console.log("Code tools report: " + dir);
const report = JSON.parse(await readFile(path.join(dir, "report.json"), "utf8"));
for (const item of report.filter((item) => item.op === "assert" || item.ok === false)) console.log(`${item.ok ? "PASS" : "FAIL"} ${item.name || item.error}`);
assert.equal(code, 0, "Code tools native scenario failed");
assert.equal(await readFile(doc, "utf8"), source, "Formatting never silently saves an open draft");
const saved = JSON.parse(await readFile(path.join(profile, "settings.json"), "utf8"));
assert.equal(saved.codeIndentSize, 2); assert.equal(saved.codeShiftTab, "outdent"); assert.equal(saved.defaultCodeLanguage, "python");
console.log("PASS code formatting, selection/whole indentation, text undo, default languages, completion, source mode, readonly, themes and persistent settings");
