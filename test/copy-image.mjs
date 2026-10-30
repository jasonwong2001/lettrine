// Clipboard PNGs from the real native WebKit path, including offscreen content.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { resolveRuntime } from "./runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(path.join(os.tmpdir(), "lettrine-copy-image-"));
const profile = path.join(dir, "profile");
await mkdir(profile);
await writeFile(path.join(profile, "settings.json"), JSON.stringify({ autosave: false, background: "light", locale: "en" }));
await writeFile(path.join(dir, "bottom.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="180" height="70"><rect width="180" height="70" fill="#e63224"/><text x="12" y="40" fill="white">End of selection</text></svg>');
const text = [
  "# Copy image review", "Text with **selected words** and <u>underline</u>.",
  "$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$",
  "```mermaid\ngraph LR\n A[Markdown] --> B[Image]\n```",
  "> [!TIP]\n> Keep **source** unchanged.",
  "| Left | Right |\n| :--- | ---: |\n| One | Two |",
  "```js\nconst value = 1;\n```",
  ...Array.from({ length: 32 }, (_, i) => `Paragraph ${i + 1}: a long selection includes content beyond the first screen. 中文图像与文稿源文本保持一致。`),
  "![End of selection](bottom.svg)",
].join("\n\n");
const doc = path.join(dir, "review.md");
await writeFile(doc, text);
const A = "window.__lettrine", E = `${A}.editor`;
const check = (name, expr, eq = true) => ({ assert: { name, expr, eq } });
const inspect = (tag) => ({ eval: `(async()=>{const shot=await window.__inspectImage();window.__shots[${JSON.stringify(tag)}]=shot;return {tag:${JSON.stringify(tag)},...shot};})()` });
const copyMenu = [
  { eval: "window.__copyResult=null" }, { cmd: "edit.copyImage" },
  { waitFor: "!!window.__copyResult?.ok", timeout: 20000 },
];
const steps = [
  { open: doc }, { focusWindow: true },
  { assertMenu: { id: "command.edit.copyImage", property: "label", eq: "Copy as Image…", name: "Edit menu offers Copy as Image" } },
  { waitFor: `!!${E}.root.querySelector('.md-diagram svg')&&!!${E}.root.querySelector('.md-img-loaded')` },
  { eval: `window.__shots={};window.__originalCopy=${A}.copyAsImage;${A}.copyAsImage=async(...args)=>(window.__copyResult=await __originalCopy(...args));window.__inspectImage=async()=>{const result=await window.bridge.clipboard.readImage();if(!result.ok)throw Error('Missing clipboard image');const image=new Image();image.src='data:image/png;base64,'+result.png;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.naturalWidth;canvas.height=image.naturalHeight;const context=canvas.getContext('2d');context.drawImage(image,0,0);const data=context.getImageData(0,0,canvas.width,canvas.height).data;const bg=Array.from(data.slice(0,4));let ink=0,bottomRed=0;for(let y=0;y<canvas.height;y++)for(let x=0;x<canvas.width;x++){const i=(y*canvas.width+x)*4;if(Math.max(Math.abs(data[i]-bg[0]),Math.abs(data[i+1]-bg[1]),Math.abs(data[i+2]-bg[2]))>40)ink++;if(y>canvas.height-240&&data[i]>180&&data[i+1]<90&&data[i+2]<90)bottomRed++;}return {png:result.png,width:canvas.width,height:canvas.height,bg,ink,bottomRed};};true` },
  { eval: "window.bridge.clipboard.write({text:'Previous text clipboard',html:'<p>Previous text clipboard</p>'})" },
  { eval: `window.__source=${E}.getMarkdown();window.__history=${E}._history.length;${E}.root.focus();${E}.selectOffsets(${text.indexOf("selected")},${text.indexOf("selected") + 8});window.__selection=${E}.selectionOffsets()` },
  ...copyMenu,
  inspect("partial"),
  check("partial selection produces a crisp, nonempty 2x PNG", "__shots.partial.ink>50&&__shots.partial.width===__copyResult.width*2&&__shots.partial.height===__copyResult.height*2"),
  check("image copy keeps the previous text and HTML available", "(async()=>{const result=await window.bridge.native.invoke('clipboard.readContent');return result.text==='Previous text clipboard'&&result.html==='<p>Previous text clipboard</p>'&&result.hasImage;})()"),
  check("copy preserves source, selection, dirty state and undo history", `${E}.getMarkdown()===__source&&${E}._history.length===__history&&JSON.stringify(${E}.selectionOffsets())===JSON.stringify(__selection)&&!${A}._dirty`),
  { eval: `${A}.copyAsImage(${E}.root.querySelector('.md-math-body'))` },
  inspect("formula"),
  check("a formula is cropped around the complete rendered equation", "__shots.formula.ink>200&&__shots.formula.width<__shots.partial.width&&__shots.formula.height>80"),
  { eval: `${E}.selectAll();window.__selection=${E}.selectionOffsets()` },
  ...copyMenu,
  inspect("long-selection"),
  check("one image contains a long selection beyond the original viewport", "__shots['long-selection'].height>window.innerHeight*2&&__shots['long-selection'].bottomRed>10000"),
  check("offscreen rendering preserves the long selection and history", `${E}.getMarkdown()===__source&&${E}._history.length===__history&&JSON.stringify(${E}.selectionOffsets())===JSON.stringify(__selection)`),
  { eval: "window.bridge.setting.put({key:'__patch',value:{background:'dark'}})" },
  { waitFor: "document.body.classList.contains('ui-dark')&&getComputedStyle(document.body).backgroundColor==='rgb(28, 29, 32)'" },
  { eval: `${A}.copyAsImage(${E}.root.querySelector('.md-math-body'))` },
  inspect("formula-dark"),
  check("dark-theme math has the correct opaque background and visible glyphs", "__shots['formula-dark'].bg.join(',')==='28,29,32,255'&&__shots['formula-dark'].ink>200"),
  { eval: `${A}.copyAsImage(${E}.root.querySelector('.md-diagram svg'))` },
  inspect("diagram-dark"),
  check("diagram copy waits for Mermaid and renders on the dark background", "__shots['diagram-dark'].bg.join(',')==='28,29,32,255'&&__shots['diagram-dark'].ink>1000"),
  { eval: `${E}.root.focus();${E}.placeCaret(0,0);document.getElementById('md-content').scrollTop=0` },
  ...copyMenu,
  inspect("current-view"),
  check("no selection captures only the current document view at 2x", "__shots['current-view'].height<=window.innerHeight*2&&__shots['current-view'].ink>1000"),
  { eval: "(async()=>{window.__zoom=(await window.bridge.window.zoom({delta:2})).zoomFactor;return true;})()" },
  { eval: "window.__viewHeight=Math.min(innerHeight,document.getElementById('md-content').getBoundingClientRect().bottom)-Math.max(0,document.getElementById('md-content').getBoundingClientRect().top)" },
  ...copyMenu,
  inspect("zoomed-view"),
  check("a zoomed document retains viewport screenshot dimensions and omits window chrome", "Math.abs(__shots['zoomed-view'].height-__viewHeight*2)<4&&__shots['zoomed-view'].bg.join(',')==='28,29,32,255'"),
  { eval: "window.bridge.window.zoom({delta:0})" },
  { cmd: "view.source" }, { waitFor: `!!${A}._sourceCM` },
  { eval: `${A}._sourceCM.setSelection({line:0,ch:0},{line:0,ch:19});${A}._sourceCM.focus();window.__sourceCursor=JSON.stringify(${A}._sourceCM.listSelections())` },
  ...copyMenu,
  inspect("source-selection"),
  check("source selections render Markdown while leaving the source view and cursor intact", `document.body.classList.contains('sourceview-on')&&${A}._sourceCM.getValue()===__source&&JSON.stringify(${A}._sourceCM.listSelections())===__sourceCursor&&__shots['source-selection'].ink>200`),
  { cmd: "view.source" },
  { eval: `${E}.root.focus();${E}.selectOffsets(0,19)` },
  { cmd: "view.readonly" },
  ...copyMenu,
  check("image copy remains available in readonly mode", `${E}.readOnly&&${E}.getMarkdown()===__source&&${E}._history.length===__history`),
  { cmd: "view.readonly" },
  { eval: `${E}.root.focus();${E}.selectOffsets(${text.indexOf("selected")},${text.indexOf("selected") + 8})` },
  { key: "Meta+Shift+C" },
  check("normal Markdown copy still replaces the clipboard with the selected text", "(async()=>{const result=await window.bridge.native.invoke('clipboard.readContent');return result.text==='selected'&&!result.hasImage;})()"),
  { key: "Meta+C" },
  check("ordinary rich copy still supplies the selected text and HTML", "(async()=>{const result=await window.bridge.native.invoke('clipboard.readContent');return result.text==='selected'&&result.html.includes('selected')&&!result.hasImage;})()"),
  check("oversized images report an error without replacing the clipboard", "(async()=>{try{await window.bridge.native.invoke('clipboard.writeImage',{html:'<article id=\"write\" style=\"height:9000px\">Too tall</article>',width:800});return false;}catch(error){const result=await window.bridge.native.invoke('clipboard.readContent');return error.message.includes('too large')&&result.text==='selected'&&!result.hasImage;}})()"),
  { eval: `${E}.root.focus();${E}.root.querySelector('.md-math-block').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))` },
  { waitFor: `!!${E}.root.querySelector('.md-math-block').__cm` },
  { eval: `window.__mathElement=${E}.root.querySelector('.md-math-block');window.__mathCM=__mathElement.__cm;__mathCM.replaceRange(' + 2',__mathCM.posFromIndex(__mathCM.getValue().length));__mathCM.focus();window.__draftHistory=${E}._history.length;window.__mathCursor=JSON.stringify(__mathCM.listSelections())` },
  ...copyMenu,
  inspect("editing-formula"),
  check("copying an edited formula uses its current TeX without closing its editor", `${E}.getMarkdown().includes(' + 2')&&${E}._history.length===__draftHistory&&__mathCM===__mathElement.__cm&&JSON.stringify(__mathCM.listSelections())===__mathCursor&&__shots['editing-formula'].width>__shots['formula-dark'].width`),
  { eval: `${A}.copyAsImage(__mathElement.querySelector('.md-math-body'))` },
  inspect("editing-formula-context"),
  check("formula context copy also uses the current TeX while its idle preview is stale", "__shots['editing-formula-context'].width===__shots['editing-formula'].width&&__shots['editing-formula-context'].ink===__shots['editing-formula'].ink"),
  { eval: `${E}.root.focus()` }, { sleep: 160 }, { key: "Meta+Z" },
  check("editing can still be undone after copying the formula", `${E}.getMarkdown()===__source`),
  { eval: `${E}.root.focus();${E}.root.querySelector('pre[lang=js]').dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))` },
  { waitFor: `!!${E}.root.querySelector('pre[lang=js]').__cm` },
  { eval: `window.__codeCM=${E}.root.querySelector('pre[lang=js]').__cm;__codeCM.setSelection({line:0,ch:0},{line:0,ch:5});__codeCM.focus();window.__codeCursor=JSON.stringify(__codeCM.listSelections())` },
  ...copyMenu,
  inspect("code-selection"),
  check("a mounted code editor copies only its selection and preserves its cursor", `__shots['code-selection'].ink>50&&__shots['code-selection'].height<200&&__codeCM.getSelection()==='const'&&JSON.stringify(__codeCM.listSelections())===__codeCursor&&${E}.getMarkdown()===__source`),
  check("image copy leaves no renderer startup errors or capture class", "window.__lettrineStartupErrors.length===0&&!document.body.classList.contains('copying-image')"),
];
const scenario = path.join(dir, "scenario.json");
await writeFile(scenario, JSON.stringify(steps, null, 2));
const { executable, args } = await resolveRuntime(root, process.argv[2]);
const child = spawn(executable, [...args, "--user-data-dir=" + profile, "--lettrine-harness", scenario, "--lettrine-out", dir], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", data => { log += data; }); child.stderr.on("data", data => { log += data; });
const timeout = setTimeout(() => child.kill("SIGTERM"), 150000);
const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
clearTimeout(timeout);
await writeFile(path.join(dir, "native.log"), log);
console.log("Copy as Image native report: " + dir);
const report = JSON.parse(await readFile(path.join(dir, "report.json"), "utf8"));
for (const item of report.filter(item => item.op === "assert" || item.ok === false)) console.log(`${item.ok ? "PASS" : "FAIL"} ${item.name || item.error}`);
const shots = Object.fromEntries(report.filter(item => item.value?.tag && item.value?.png).map(item => [item.value.tag, item.value]));
for (const [name, shot] of Object.entries(shots)) {
  const png = Buffer.from(shot.png, "base64");
  assert.equal(png.readUInt32BE(16), shot.width); assert.equal(png.readUInt32BE(20), shot.height);
  await writeFile(path.join(dir, name + ".png"), png);
}
assert.equal(code, 0, "Copy as Image native scenarios failed");
assert.equal(await readFile(doc, "utf8"), text);
