import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { resolveRuntime } from "./runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url)), dir = await mkdtemp(path.join(os.tmpdir(), "lettrine-zoom-ux-")), profile = path.join(dir, "profile");
await mkdir(profile); await writeFile(path.join(profile, "settings.json"), JSON.stringify({ autosave: false, locale: "en", welcomeShown: true, background: "light" }));
const source = "# Zoom\n\nalpha omega\n\n```js\nconst value = 1;\n```", doc = path.join(dir, "zoom.md");
await writeFile(doc, source);
const A = "window.__lettrine", E = A + ".editor", q = JSON.stringify;
const check = (name, expr, eq = true) => ({ assert: { name, expr, eq } });
const zoom = factor => ({ eval: `(async()=>{const result=await window.bridge.window.zoom({factor:${factor}});for(let i=0;i<100&&${A}.documentZoom!==result.zoomFactor;i++)await new Promise(resolve=>setTimeout(resolve,10));return result})()` });
const wheel = (options, target = "#md-content") => ({ eval: `(()=>{const event=new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaY:-40,...${JSON.stringify(options)}});document.querySelector(${q(target)}).dispatchEvent(event);return event.defaultPrevented})()` });
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
  assert.equal(code, 0, "Native zoom failed: " + suffix); assert.ok(report.every(item => item.ok));
}
console.log("Document zoom report: " + dir);
await run([
  { open: doc },
  check("document zoom defaults to 100 percent, hides its title-bar percentage and keeps mouse zoom opt-in", `${A}.documentZoom===1&&document.getElementById('tb-zoom').hidden&&!${A}.settings.zoomByMouse`),
  { eval: `window.__root=${E}.root;window.__paragraph=${E}.root.querySelector('p');window.__history=${E}._history.length;window.__bar=document.getElementById('doc-bar').getBoundingClientRect().height;window.__sidebar=document.getElementById('app-sidebar').getBoundingClientRect().width;window.__paragraphHeight=__paragraph.getBoundingClientRect().height` },
  { cmd: "view.zoomPopover" },
  check("View › Document Zoom opens the popover from the revealed percentage", "!document.getElementById('zoom-popover').hidden&&!document.getElementById('tb-zoom').hidden&&document.getElementById('tb-zoom').getAttribute('aria-expanded')==='true'"),
  { eval: "document.querySelector(\"#zoom-popover [data-command='view.zoomIn']\").click()" },
  { waitFor: `${A}.documentZoom===1.1` },
  check("popover controls show the saved current zoom", "document.getElementById('zoom-value').textContent==='110%'&&!document.getElementById('zoom-popover').hidden"),
  { eval: "document.querySelector(\"#zoom-popover [data-command='view.actualSize']\").click()" }, { waitFor: `${A}.documentZoom===1` },
  { key: "Escape" },
  check("Escape at actual size closes the popover, hides the percentage and returns focus to the document", "document.getElementById('zoom-popover').hidden&&document.getElementById('tb-zoom').hidden&&document.activeElement.id==='write'"),
  zoom(1.5),
  { capture: "zoom-150" },
  check("zoom scales the document while keeping the native bar and sidebar stable", "Math.abs(__paragraph.getBoundingClientRect().height/__paragraphHeight-1.5)<0.03&&document.getElementById('doc-bar').getBoundingClientRect().height===__bar&&document.getElementById('app-sidebar').getBoundingClientRect().width===__sidebar&&document.getElementById('md-content').scrollWidth<=document.getElementById('md-content').clientWidth+1"),
  check("presentation changes retain the exact model, DOM and history", `${E}.root===__root&&${E}.root.querySelector('p')===__paragraph&&${E}.getMarkdown()===${q(source)}&&${E}._history.length===__history`),
  { eval: `${E}.root.focus();${E}.selectOffsets(${source.indexOf("omega") + 5})` }, { type: " tail" },
  check("native preview typing works at 150 percent", `${E}.getMarkdown()`, source.replace("omega", "omega tail")),
  { key: "Meta+Z" }, check("zoomed preview typing retains normal undo", `${E}.getMarkdown()`, source),
  { eval: `${E}.root.querySelector('pre[lang=js]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))` },
  { waitFor: `!!${E}.root.querySelector('pre[lang=js]').__cm` },
  { eval: `window.__codeCM=${E}.root.querySelector('pre[lang=js]').__cm;__codeCM.setCursor({line:0,ch:16});__codeCM.focus()` },
  { type: " // zoom" },
  check("mounted code editors accept real input at document zoom", "__codeCM.getValue()", "const value = 1; // zoom"),
  zoom(2),
  check("zoom preserves the mounted editor and its cursor", `${E}.root.querySelector('pre[lang=js]').__cm===__codeCM&&__codeCM.getCursor().ch===24`),
  { eval: `${E}.root.focus()` }, { key: "Meta+Z" },
  check("mounted code changes remain undoable after zoom", `${E}.getMarkdown()`, source),
  { cmd: "view.source" }, { waitFor: `!!${A}._sourceCM` },
  check("Source Code Mode fonts follow document zoom", `parseFloat(getComputedStyle(${A}._sourceCM.getWrapperElement()).fontSize)`, 28),
  { eval: `${A}._sourceCM.setCursor({line:2,ch:11});${A}._sourceCM.focus();window.__sourceCM=${A}._sourceCM;true` }, { type: " source" },
  zoom(1.2),
  check("source zoom preserves its editor and selection", `${A}._sourceCM===__sourceCM&&__sourceCM.getCursor().ch===18&&Math.abs(parseFloat(getComputedStyle(__sourceCM.getWrapperElement()).fontSize)-16.8)<0.01`),
  { key: "Meta+Z" }, check("source typing retains history across zoom", "__sourceCM.getValue()", source),
  { cmd: "view.source" }, zoom(5),
  check("zoom clamps at 300 percent and disables further zoom in", `${A}.documentZoom===3&&document.querySelector('#zoom-popover [data-command="view.zoomIn"]').disabled`),
  zoom(0.1),
  check("zoom clamps at 50 percent and disables further zoom out", `${A}.documentZoom===0.5&&document.querySelector('#zoom-popover [data-command="view.zoomOut"]').disabled`),
  zoom(1), { eval: "Promise.all(Array.from({length:5},()=>window.bridge.window.zoom({delta:1})))" },
  check("concurrent native zoom increments accumulate without lost updates", `${A}.documentZoom`, 1.5),
  ...[wheel({ metaKey: true }), { sleep: 120 }],
  check("modifier scrolling is inert until enabled", `${A}.documentZoom`, 1.5),
  { cmd: "view.zoomPopover" }, { eval: "document.getElementById('zoom-mouse-option').click()" }, { key: "Escape" },
  wheel({ metaKey: true }), { waitFor: `${A}.documentZoom===1.6` },
  wheel({ ctrlKey: true }), { waitFor: `${A}.documentZoom===1.7` },
  wheel({}), { sleep: 120 },
  check("ordinary scrolling keeps its reading behavior", `${A}.documentZoom`, 1.7),
  wheel({ metaKey: true }, "#app-sidebar"), { sleep: 120 },
  check("sidebar scrolling cannot change document zoom", `${A}.documentZoom`, 1.7),
  { cmd: "view.readonly" }, { cmd: "view.zoomOut" },
  check("readonly still permits reading zoom without source changes", `${E}.readOnly&&${A}.documentZoom===1.6&&${E}.getMarkdown()===${q(source)}`),
  { cmd: "view.readonly" },
  { eval: "window.bridge.i18n.setLocale({locale:'zh-Hans'})" }, { waitFor: `${A}.i18n.locale==='zh-Hans'` },
  { eval: "if(document.getElementById('zoom-popover').hidden)document.getElementById('tb-zoom').click()" },
  check("zoom controls are localized", "document.getElementById('zoom-popover').getAttribute('aria-label')==='文档缩放'&&document.querySelector('#zoom-popover [data-command=\"view.actualSize\"]').textContent==='实际大小'"),
  check("the popover fits within the visible window", "(()=>{const el=document.getElementById('zoom-popover'),r=el.getBoundingClientRect();return !el.hidden&&r.width>250&&r.height>50&&r.left>=0&&r.right<=innerWidth&&r.top>40&&r.bottom<innerHeight})()"),
  { eval: "document.getAnimations().forEach(animation=>animation.finish())" },
  { capture: "zoom-light" },
  { eval: "window.bridge.setting.put({key:'__patch',value:{background:'dark'}})" }, { waitFor: "document.body.classList.contains('ui-dark')" },
  { capture: "zoom-dark" }, { key: "Escape" },
  check("Escape while zoomed returns keyboard focus to the visible percentage", "document.getElementById('zoom-popover').hidden&&!document.getElementById('tb-zoom').hidden&&document.activeElement.id==='tb-zoom'"),
  { window: "new" }, check("new windows inherit the app zoom and mouse preference", `${A}.documentZoom===1.6&&${A}.settings.zoomByMouse`),
  zoom(1.3), { tab: "close" }, check("zoom changes synchronize across open windows", `${A}.documentZoom`, 1.3),
  check("zoom leaves no startup errors", "window.__lettrineStartupErrors", []),
], "editing");
await run([
  check("zoom and mouse preference survive an actual application restart", `${A}.documentZoom===1.3&&${A}.settings.zoomByMouse&&document.getElementById('tb-zoom').textContent==='130%'&&!document.getElementById('tb-zoom').hidden`),
  { cmd: "view.actualSize" }, check("Actual Size resets the persisted zoom", `${A}.documentZoom`, 1), check("the percentage hides again at actual size", "document.getElementById('tb-zoom').hidden"),
], "relaunch");
assert.equal(await readFile(doc, "utf8"), source);
console.log("PASS persistent document zoom, popover controls, stable chrome, preview/code/source typing and undo, bounds, concurrent requests, opt-in mouse gestures, windows, readonly, localization and themes");
