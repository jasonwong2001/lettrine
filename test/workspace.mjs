// Native workspace interactions and a repeatable long-document benchmark.
// Run separately from the other native suites: they share keyboard focus.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { resolveRuntime } from "./runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(path.join(os.tmpdir(), "lettrine-workspace-"));
const library = path.join(dir, "Writing");
const profile = path.join(dir, "profile");
await mkdir(path.join(library, "Notes"), { recursive: true });
const canonicalLibrary = await realpath(library);
await mkdir(profile);
await writeFile(path.join(profile, "settings.json"), JSON.stringify({ locale: "en", background: "light", autosave: false }));
const doc = path.join(library, "A little space to think.md");
const findDoc = path.join(dir, "Find results.md");
await writeFile(findDoc, Array.from({ length: 60 }, (_, index) => index === 20 || index === 40 ? `needle ${index}` : `Paragraph ${index} with ordinary words.`).join("\n\n"));
await writeFile(doc, "# A little space to think\n\nGood tools make room for your ideas. Capture a thought, shape a draft, and keep your attention on the words.\n\n## Start with the essentials\n\n- Keep your notes close at hand\n- Move between documents with **Quick Open**\n- Turn a rough idea into something worth sharing\n\n## Built for your flow\n\nWrite in **Markdown**, see it take shape as you type.\n\n> The best interface gives your work room to breathe.\n");
for (const name of ["Project notes", "Reading list", "Meeting notes", "Release checklist"]) await writeFile(path.join(library, name + ".md"), "# " + name);
for (let i = 1; i <= 45; i++) await writeFile(path.join(library, "Notes", `Idea ${String(i).padStart(2, "0")}.md`), "# A new idea");
const A = "window.__lettrine", E = `${A}.editor`;
const check = (name, expr, eq = true) => ({ assert: { name, expr, eq } });
const typing = (text) => [...text].map((character) => ({ type: character, wait: 35 }));
const benchmark = `(async()=>{
  const a=${A},e=a.editor;
  const source=Array.from({length:1000},(_,i)=>'Paragraph '+i+' — A clear workspace helps keep your attention on writing. 中文编辑与性能优化。 '+ 'Read and write with confidence. '.repeat(3)).join('\\n\\n');
  const t=performance.now(); e.setText(source); e.root.focus(); e.placeCaret(999,e.blocks[999].src.length);
  const renderMs=performance.now()-t;
  const {updateWordCount}=await import('./ui.js'); updateWordCount(e);
  const measure=(fn,n)=>{const values=[];for(let i=0;i<n;i++){const s=performance.now();fn(i);values.push(performance.now()-s);}values.sort((a,b)=>a-b);return {medianMs:values[Math.floor(n/2)],p95Ms:values[Math.floor(n*.95)]};};
  const stats=measure(()=>updateWordCount(e),30);
  const focus=measure(()=>a.updateWritingModes(),30);
  const input=measure(()=>{const text=e.root.lastElementChild.querySelector('.md-plain').firstChild;text.appendData('x');const s=getSelection(),r=document.createRange();r.setStart(text,text.length);r.collapse(true);s.removeAllRanges();s.addRange(r);e.handleInput({inputType:'insertText'});},20);
  return {blocks:e.blocks.length,chars:e.getMarkdown().length,renderMs,stats,focus,input};
})()`;
const steps = [
  { focusWindow: true },
  { eval: "window.__workspaceErrors=[];addEventListener('error',e=>__workspaceErrors.push(e.message));addEventListener('unhandledrejection',e=>__workspaceErrors.push(String(e.reason)))" },
  { eval: "window.__folderPicker=window.bridge.window.openFolder;window.__folderPickerCalls=0;window.bridge.window.openFolder=async()=>{__folderPickerCalls++;return {canceled:true}}" },
  { click: '.library-empty .ui-btn-primary' },
  check("the empty library offers a folder picker", '__folderPickerCalls', 1),
  { eval: 'window.bridge.window.openFolder=window.__folderPicker' },
  { open: doc }, { capture: "document" },
  check("an open document keeps the sidebar on the library, not a file pane", "document.querySelector('#file-library').hidden===false&&!!document.querySelector('.library-empty')"),
  { open: findDoc },
  { eval: `${E}.root.focus();${E}.selectOffsets(0);document.querySelector('#md-content').scrollTop=0` },
  { cmd: "edit.find" }, ...typing("needle"),
  { waitFor: "document.querySelector('#search-panel-status').textContent==='1 of 2'" },
  check("incremental find reveals the first match and keeps the query focused", `(()=>{const node=${E}.root.children[20].getBoundingClientRect(),bounds=document.querySelector('#md-content').getBoundingClientRect();return node.top>=bounds.top&&node.bottom<=bounds.bottom&&document.activeElement.id==='search-panel-input';})()`),
  { key: "Enter" },
  check("Enter advances from the revealed match to the second match", `(()=>{const node=${E}.root.children[40].getBoundingClientRect(),bounds=document.querySelector('#md-content').getBoundingClientRect();return document.querySelector('#search-panel-status').textContent==='2 of 2'&&node.top>=bounds.top&&node.bottom<=bounds.bottom;})()`),
  { click: "#search-panel-close" },
  { click: "#tb-source" }, { waitFor: `!!${A}._sourceCM` },
  { eval: `${A}._sourceCM.setCursor({line:0,ch:0})` },
  { cmd: "edit.find" }, ...typing("needle"),
  { waitFor: "document.querySelector('#search-panel-status').textContent==='1 of 2'" },
  check("incremental find also selects source text while keeping the query focused", `${A}._sourceCM.getSelection()==='needle'&&${A}._sourceCM.getCursor('from').line===40&&document.activeElement.id==='search-panel-input'`),
  { click: "#search-panel-close" }, { click: "#tb-source" },
  { open: doc },
  { eval: `${A}.openFolder(${JSON.stringify(canonicalLibrary)})` },
  { cmd: "view.files" },
  check("the list view is a persistent, dated document list", `(async()=>{const settings=await window.bridge.setting.get({key:'__patch'});return ${A}.fileView==='list'&&settings.fileView==='list'&&document.querySelector('#file-library-list').getAttribute('role')==='list'&&!document.querySelector('#file-library-list [data-kind=folder]');})()`),
  { cmd: "view.tree" },
  check("an aliased folder path produces visible tree entries", `(()=>{const a=${A},tree=document.querySelector('#file-library-list');return a.fileView==='tree'&&a.files.every(f=>f.path.startsWith(a.folder+'/'))&&tree.textContent.includes(${JSON.stringify(path.basename(doc))})&&[...tree.querySelectorAll('[role="treeitem"]')].some(row=>row.getBoundingClientRect().height>0);})()`),
  { eval: `${A}.openFolder(${JSON.stringify(library)})` },
  { cmd: "edit.findInFiles" }, ...typing("Good tools"),
  { waitFor: "!!document.querySelector('.search-match-row')" },
  { eval: `${A}.openFolder(${JSON.stringify(path.join(library, "Notes"))})` },
  check("switching libraries replaces search results with the new library's files", "document.querySelector('#file-library-search-input').value===''&&document.querySelector('#file-library-search').hidden&&!document.querySelector('#file-library').hidden&&document.querySelector('#file-library-list').textContent.includes('Idea 01')"),
  { cmd: "edit.findInFiles" }, ...typing("new idea"),
  { waitFor: "!!document.querySelector('.search-match-row')" },
  { cmd: "library.closeFolder" },
  check("closing a searched library reveals its empty state", "document.querySelector('#file-library-search').hidden&&!document.querySelector('#file-library').hidden&&document.querySelector('#file-library-search-result').textContent===''&&!!document.querySelector('.library-empty')"),
  { eval: `${A}.openFolder(${JSON.stringify(library)})` },
  { capture: "workspace-light" },
  check("the sidebar header names the current library", "document.querySelector('#library-name').textContent", "Writing"),
  check("the title bar follows the window buttons AppKit placed in the toolbar", "(()=>{const style=getComputedStyle(document.documentElement),toggle=document.querySelector('#sidebar-toggle-in').getBoundingClientRect();return style.getPropertyValue('--ui-bar').trim()==='52px'&&Math.abs(toggle.top+toggle.height/2-26)<=1&&toggle.left>=60&&Math.abs(toggle.left-parseFloat(style.getPropertyValue('--ui-window-buttons')))<=1;})()"),
  { tab: "new" },
  { waitFor: "parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-tabbar'))>0", diagnostic: "getComputedStyle(document.documentElement).getPropertyValue('--ui-tabbar')" },
  check("a native tab bar pushes the sidebar and document below it", "(()=>{const tab=parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--ui-tabbar'));return document.querySelector('.library-head').getBoundingClientRect().top>=52+tab&&document.querySelector('#md-content').getBoundingClientRect().top>=52+tab;})()"),
  { tab: "close" },
  { waitFor: "getComputedStyle(document.documentElement).getPropertyValue('--ui-tabbar').trim()==='0px'", diagnostic: "getComputedStyle(document.documentElement).getPropertyValue('--ui-tabbar')" },
  // Native menus cannot be clicked by the harness; pick an item through the bridge.
  { eval: "window.__menuPopup=window.bridge.menu.popup;window.bridge.menu.popup=async(request)=>{window.__lastMenu=request;const find=(items)=>{for(const item of items){if(item.label==='Sort by Date Modified')return item.id;const inner=item.submenu&&find(item.submenu);if(inner)return inner;}};return {id:find(request.items)};}" },
  { click: '#library-options-btn' },
  check("view options are offered as a native menu with the current view checked", "window.__lastMenu.items.some(item=>item.label==='View as Tree'&&item.checked)&&window.__lastMenu.items.some(item=>item.label==='Sort by Date Modified')"),
  check("choosing a native menu item runs its action", `${A}.sort.key==='date'&&!${A}.sort.asc`),
  { eval: "window.bridge.menu.popup=window.__menuPopup" },
  { cmd: "file.preferences" }, { key: "Meta+Shift+O" },
  check("Quick Open takes focus above Settings without dismissing it", "!!document.querySelector('#preferences-dialog.open')&&!document.querySelector('#quick-open').hidden&&document.activeElement===document.querySelector('#quick-open-input input')"),
  ...typing("Idea"),
  check("the top dialog accepts native typing", "document.querySelector('#quick-open-input input').value", "Idea"),
  { key: "Escape" },
  check("Escape closes Quick Open and restores Settings focus", "document.querySelector('#quick-open').hidden&&!!document.querySelector('#preferences-dialog.open')&&document.querySelector('#preferences-dialog').contains(document.activeElement)"),
  { key: "Escape" },
  { waitFor: "!document.querySelector('#preferences-dialog.open')" },
  { cmd: "file.openQuickly" },
  check("Quick Open is visible and its search field receives pointer input", "(()=>{const el=document.querySelector('#quick-open-input input'),r=el.getBoundingClientRect();return r.width>0&&r.height>0&&document.elementFromPoint(r.left+r.width/2,r.top+r.height/2)===el&&document.activeElement===el;})()"),
  check("Quick Open groups recent files and the library's files", "[...document.querySelectorAll('#quick-open .qo-group:not([hidden]) .qo-group-title')].map(node=>node.textContent).join('|')", "Recent Files|In “Writing”|Recent Folders"),
  { eval: "window.__firstQuickRow=document.querySelector('.quick-open-item')" },
  { key: "ArrowDown" },
  check("arrow navigation retains existing result rows", "window.__firstQuickRow.isConnected"),
  ...typing("Idea"),
  { waitFor: "document.querySelectorAll('.quick-open-item').length===45", diagnostic: `({query:document.querySelector('#quick-open-input input').value,scope:${A}.folder,names:[...document.querySelectorAll('.qo-name')].map(n=>n.textContent)})` },
  ...Array.from({ length: 16 }, () => ({ key: "ArrowDown", wait: 20 })),
  check("keyboard selection scrolls into view", "(()=>{const el=document.querySelector('.quick-open-item.active'),r=el.getBoundingClientRect(),p=document.querySelector('#quick-open-list').getBoundingClientRect();return r.top>=p.top&&r.bottom<=p.bottom+1;})()"),
  { capture: "quick-open" },
  { key: "Meta+A" }, ...typing("zzzz"),
  { waitFor: "!document.querySelector('#quick-open-empty').hidden&&document.querySelector('#quick-open-empty').textContent==='No matching files'" },
  { key: "Escape" },
  check("Escape closes Quick Open", "document.querySelector('#quick-open').hidden"),
  { eval: `${E}.root.focus();${E}.selectOffsets(${E}.getMarkdown().length);window.__previewHeading=${E}.root.firstElementChild` },
  { click: "#tb-source" }, { waitFor: `!!${A}._sourceCM` },
  ...typing(" native"),
  check("native source input synchronizes without rebuilding the hidden preview", `${E}.getMarkdown().endsWith(' native')&&${E}.root.firstElementChild===window.__previewHeading`),
  { click: "#tb-source" },
  check("leaving source view renders the edit and keeps unchanged blocks", `${E}.root.firstElementChild===window.__previewHeading&&${E}.root.textContent.endsWith(' native')&&${E}.root.children.length===${E}.blocks.length`),
  { eval: "window.bridge.setting.put({key:'__patch',value:{background:'dark'}})" },
  { waitFor: `${A}.theme==='lettrine-dark'&&getComputedStyle(document.documentElement).getPropertyValue('--bg-color').trim()==='#1c1d20'` },
  check("dark themes switch the chrome to its dark appearance", "document.body.classList.contains('ui-dark')&&document.documentElement.style.colorScheme==='dark'"),
  { capture: "workspace-dark" }, { cmd: "file.openQuickly" }, { capture: "quick-open-dark" }, { key: "Escape" },
  { eval: `window.__darkSourceText=${E}.getMarkdown()` },
  { click: '#tb-source' }, { waitFor: `!!${A}._sourceCM` },
  check("source mode retains the dark theme and readable source", `(()=>{const cm=${A}._sourceCM,style=getComputedStyle(cm.getWrapperElement()),pane=getComputedStyle(document.querySelector('#app-source'));const gutters=getComputedStyle(cm.getWrapperElement().querySelector('.CodeMirror-gutters')),caret=getComputedStyle(cm.getWrapperElement().querySelector('.CodeMirror-cursor')).borderLeftColor;return cm.getValue()===window.__darkSourceText&&style.backgroundColor==='rgb(28, 29, 32)'&&style.color===pane.color&&(gutters.display==='none'||gutters.backgroundColor===style.backgroundColor)&&caret!==style.backgroundColor&&!/rgba\(0, 0, 0, 0\)/.test(caret);})()`),
  { capture: 'source-dark' }, { click: '#tb-source' },
  check("leaving dark source mode preserves the document and theme", `${E}.getMarkdown()===window.__darkSourceText&&${A}.theme==='lettrine-dark'&&!document.body.classList.contains('sourceview-on')`),
  { eval: "window.bridge.i18n.setLocale({locale:'zh-Hans'})" },
  { waitFor: "document.querySelector('#titlebar-document-status').textContent==='已编辑'" },
  check("locale changes preserve the document name", "document.querySelector('#titlebar-document-name').textContent", path.basename(doc)),
  { capture: "workspace-chinese" },
  { eval: "window.bridge.i18n.setLocale({locale:'en'})" },
  { eval: "window.bridge.setting.put({key:'__patch',value:{background:'light'}})" },
  { eval: benchmark },
  check("benchmark retains all blocks and edits", `${E}.blocks.length===1000&&${E}.getMarkdown().endsWith('x'.repeat(20))`),
  check("no renderer errors", "window.__workspaceErrors", []),
];
const scenario = path.join(dir, "scenario.json");
await writeFile(scenario, JSON.stringify(steps, null, 2));
const { executable, args: runtimeArgs } = await resolveRuntime(root, process.argv[2]);
const child = spawn(executable, [...runtimeArgs, `--user-data-dir=${profile}`, "--lettrine-harness", scenario, "--lettrine-out", dir], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", (data) => { log += data; });
child.stderr.on("data", (data) => { log += data; });
const timeout = setTimeout(() => child.kill("SIGTERM"), 180000);
const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("exit", resolve); });
clearTimeout(timeout);
await writeFile(path.join(dir, "native.log"), log);
console.log(`Workspace report: ${dir}`);
const report = JSON.parse(await readFile(path.join(dir, "report.json"), "utf8"));
for (const result of report.filter((r) => r.op === "assert" || r.ok === false)) console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name || result.error}`);
const measurement = report.find((r) => r.value?.input?.medianMs !== undefined)?.value;
if (measurement) console.log("Long-document benchmark:", JSON.stringify(measurement));
assert.equal(code, 0, "Native workspace regression failed");
