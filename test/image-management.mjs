import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { JSDOM } from "jsdom";
import { resolveRuntime } from "./runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(path.join(os.tmpdir(), "lettrine-images-")), profile = path.join(dir, "profile"), assets = path.join(dir, "assets");
const moved = path.join(dir, "moved"), library = path.join(dir, "library"), batch = path.join(dir, "batch");
for (const folder of [profile, assets, moved, library]) await mkdir(folder);
await writeFile(path.join(profile, "settings.json"), JSON.stringify({ autosave: false, openAfterExport: false, background: "light", locale: "en" }));
const red = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="96"><rect width="160" height="96" rx="12" fill="#e34838"/></svg>';
const blue = '<svg xmlns="http://www.w3.org/2000/svg" width="72" height="72"><circle cx="36" cy="36" r="32" fill="#3981df"/></svg>';
await writeFile(path.join(assets, "one.svg"), red); await writeFile(path.join(assets, "two.svg"), blue);
const source = '# Image lifecycle\n\n![Red](assets/one.svg "Title")\n\nInline <IMG SRC="assets/one.svg" ALT="Red" width="64">\n\n![Blue](assets/two.svg)\n\n`![literal](assets/one.svg)`\n\nBody';
const doc = path.join(dir, "images.md"); await writeFile(doc, source);
const sharedReview = path.join(dir, "shared-review.md"); await writeFile(sharedReview, "![Shared](moved/red%20%23%20renamed.svg)");
await writeFile(path.join(library, "shared red.svg"), red);
const folderA = '![A](<shared red.svg> \'keep title\')\r\n\r\n`![literal](shared red.svg)`\r\n';
const folderB = '> ![B](shared%20red.svg)\n\n<img src="shared%20red.svg" alt="B">\n';
await writeFile(path.join(library, "a.md"), folderA); await writeFile(path.join(library, "b.md"), folderB);
const command = path.join(dir, "test-uploader"), upic = path.join(dir, "test-upic"), picgo = path.join(dir, "test-picgo"), failing = path.join(dir, "failing-uploader");
const shellQuote = (text) => "'" + text.replace(/'/g, "'\\''") + "'";
await writeFile(command, "#!/bin/sh\nprintf '%s\\n' \"$@\" > " + shellQuote(path.join(dir, "command-args.txt")) + "\nprintf 'https://images.example.test/command.png\\n'\n", { mode: 0o755 });
await writeFile(upic, "#!/bin/sh\nprintf '%s\\n' \"$@\" > " + shellQuote(path.join(dir, "upic-args.txt")) + "\nprintf 'https://images.example.test/upic.png\\n'\n", { mode: 0o755 });
await writeFile(picgo, "#!/bin/sh\nprintf 'started' > " + shellQuote(path.join(dir, "picgo-started.txt")) + "\n", { mode: 0o755 });
await writeFile(failing, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
const requests = [];
const server = createServer(async (request, response) => {
  const chunks = []; for await (const chunk of request) chunks.push(chunk);
  requests.push({ url: request.url, headers: request.headers, body: Buffer.concat(chunks) });
  if (request.url === "/slow") await new Promise(resolve => setTimeout(resolve, 1200));
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(request.url === "/picgo" ? { success: true, result: ["https://images.example.test/picgo.png"] } : request.url === "/invalid" ? { data: { link: "file:///private/local.png" } } : { data: { link: "https://images.example.test/http.png" } }));
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const endpoint = "http://127.0.0.1:" + server.address().port;
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=";
const A = "window.__lettrine", E = `${A}.editor`, q = JSON.stringify, destination = path.join(moved, "red # renamed.svg"), copy = path.join(moved, "copy.svg");
const check = (name, expr, eq = true) => ({ assert: { name, expr, eq } });
const exists = (file) => `(async()=>{try{return !(await window.bridge.path.stat({path:${q(file)}})).isDirectory}catch{return false}})()`;
const upload = (name) => `window.bridge.images.import({docPath:${q(doc)},name:${q(name)},data:${q(png)},upload:true})`;
const settings = (value) => `window.bridge.setting.put({key:'__patch',value:${q(value)}})`;
const steps = [
  { open: doc }, { focusWindow: true }, { waitFor: `${E}.root.querySelectorAll('.md-img-loaded').length===3` },
  { assertMenu: { id: "command.images.moveFolder", property: "label", eq: "Move All Folder Images To…", name: "Format menu exposes folder image management" } },
  { eval: `window.__imageMenu=null;window.__showImageMenu=window.__lettrineShowMenu;window.__lettrineShowMenu=items=>{window.__imageMenu=items};${E}._handleImageContext({target:${E}.root.querySelector('img'),preventDefault(){},clientX:400,clientY:200})` },
  check("image context menu offers lifecycle, syntax and zoom controls", "['Open Image','Image Zoom','Copy Image File To…','Rename or Move Image File…','Delete Image File…','Use Markdown Image Syntax','Use HTML Image Syntax'].every(label=>__imageMenu.some(item=>item?.label===label))"),
  { eval: "__imageMenu.find(item=>item?.label==='Image Zoom').submenu.find(item=>item.label==='50%').run()" },
  check("image zoom is an undoable HTML source edit", `${E}.getMarkdown().includes('style="zoom:50%;"')&&${E}.root.querySelector('img').style.zoom==='0.5'`),
  { key: "Meta+Z" },
  check("undo restores the original image spelling", `${E}.getMarkdown()`, source),
  { eval: `window.__lettrineShowMenu=__showImageMenu;${E}.selectOffsets(0,${source.length})` },
  { cmd: "images.html" },
  check("HTML conversion covers real images while leaving code literal", `${E}.getMarkdown().includes('<img src="assets/one.svg"')&&${E}.getMarkdown().includes(${q('`![literal](assets/one.svg)`')})`),
  { key: "Meta+Z" },
  { eval: `${E}.selectOffsets(${source.length});${E}.replaceSelection(' + draft')` },
  check("moving an image file succeeds", `${A}.manageImages('assets/one.svg','move',{destination:${q(destination)}}).then(result=>result?.count===1)`),
  { waitFor: `${E}.getMarkdown().includes('moved/red%20%23%20renamed.svg')` },
  check("moved images repair Markdown and HTML references, preserving draft and literal code", `${E}.getMarkdown().includes('SRC="./moved/red %23 renamed.svg"')&&${E}.getMarkdown().endsWith(' + draft')&&${E}.getMarkdown().includes(${q('`![literal](assets/one.svg)`')})&&${A}._dirty`),
  { key: "Meta+Z" },
  check("text undo retains repaired image paths", `!${E}.getMarkdown().endsWith(' + draft')&&${E}.getMarkdown().includes('red%20%23%20renamed.svg')`),
  { key: "Meta+Shift+Z" },
  check("text redo retains repaired image paths", `${E}.getMarkdown().endsWith(' + draft')&&${E}.getMarkdown().includes('red%20%23%20renamed.svg')`),
  { eval: "window.bridge.fileOperation.undo()" },
  { waitFor: `${E}.getMarkdown().includes('./assets/one.svg')` },
  check("file undo restores the source image", exists(path.join(assets, "one.svg"))),
  { eval: "window.bridge.fileOperation.redo()" },
  { waitFor: `${E}.getMarkdown().includes('red%20%23%20renamed.svg')` },
  check("file redo restores the destination image", exists(destination)),
  check("an occupied image destination is rejected without moving files", `(async()=>{try{await window.bridge.images.manage({operation:'move',reference:'./moved/red %23 renamed.svg',destination:${q(path.join(assets, "two.svg"))},docPath:${q(doc)}});return false}catch{return ${exists(destination)}}})()`),
  check("copying an image file leaves references unchanged", `(async()=>{const before=${E}.getMarkdown();const result=await ${A}.manageImages('./moved/red %23 renamed.svg','copy',{destination:${q(copy)}});return result.count===1&&${E}.getMarkdown()===before})()`),
  { eval: "window.bridge.fileOperation.undo()" },
  check("copy file undo removes only the copy", `(async()=>!await ${exists(copy)}&&await ${exists(destination)})()`),
  { eval: "window.bridge.fileOperation.redo()" },
  check("copy file redo restores the copy", exists(copy)),
  check("file undo refuses to delete an externally changed image", `(async()=>{await window.bridge.images.saveAs({url:${q("data:image/svg+xml," + encodeURIComponent(blue))},destination:${q(copy)}});try{await window.bridge.fileOperation.undo();return false}catch{return (await window.bridge.document.read({path:${q(copy)}})).text===${q(blue)}}})()`),
  { eval: `window.bridge.images.saveAs({url:${q("data:image/svg+xml," + encodeURIComponent(red))},destination:${q(copy)}})` },
  { eval: `void ${A}.manageImages('./moved/red %23 renamed.svg','delete')` },
  { waitFor: "!!document.querySelector('#confirm-choice-btns')" },
  { click: '#confirm-choice-btns [data-choice="Cancel"]' },
  check("canceling image deletion retains the file", exists(destination)),
  check("confirmed deletion keeps a visible broken reference", `${A}.manageImages('./moved/red %23 renamed.svg','delete',{confirmed:true}).then(result=>result.count===1)`),
  { waitFor: `!!${E}.root.querySelector('.md-img-error .md-img-hint')` },
  { capture: "deleted-reference" },
  { eval: "window.bridge.fileOperation.undo()" },
  { waitFor: `${E}.root.querySelectorAll('.md-img-loaded').length===3` },
  check("file undo restores deleted images and retains the draft", `${E}.getMarkdown().endsWith(' + draft')&&${E}.getMarkdown().includes('red%20%23%20renamed.svg')`),
  check("document batch copy deduplicates repeated references", `${A}.manageImages(null,'copy',{dir:${q(path.join(dir, "document-copies"))}}).then(result=>result.count===2)`),
  { eval: "window.bridge.fileOperation.undo()" },
  check("batch copy undo removes every new copy", `(async()=>!await ${exists(path.join(dir, "document-copies", "two.svg"))}&&await ${exists(path.join(assets, "two.svg"))})()`),
  { eval: "window.bridge.fileOperation.redo()" },
  check("document batch move repairs every local image", `${A}.manageImages(null,'move',{dir:${q(path.join(dir, "document-moved"))}}).then(result=>result.count===2)`),
  { waitFor: `${E}.getMarkdown().includes('document-moved/two.svg')` },
  { eval: "window.bridge.fileOperation.undo()" },
  { waitFor: `${E}.getMarkdown().includes('./assets/two.svg')` },
  check("batch move undo retains the dirty draft and restores all image files", `(async()=>${E}.getMarkdown().endsWith(' + draft')&&await ${exists(destination)}&&await ${exists(path.join(assets, "two.svg"))})()`),
  { eval: `window.bridge.window.newTab({path:${q(sharedReview)}})` },
  { waitFor: `${A}?._booted&&${A}.file===${q(sharedReview)}` },
  { cmd: "view.readonly" },
  { switch: -1 },
  check("moving a shared image cannot modify another open readonly document", `(async()=>{try{await window.bridge.images.manage({operation:'move',reference:'./moved/red %23 renamed.svg',destination:${q(path.join(moved, "readonly-shared.svg"))}});return false}catch(e){return e.message.includes('readonly document')&&await ${exists(destination)}}})()`),
  { switch: 1 }, { tab: "close" },
  { waitFor: `${A}.file===${q(doc)}` },
  { cmd: "view.source" }, { waitFor: `!!${A}._sourceCM` },
  { eval: `${A}._sourceCM.setCursor(${A}._sourceCM.posFromIndex(${A}._sourceCM.getValue().length));${A}._sourceCM.replaceSelection(' + source edit','end','+input');${A}._sourceCM.focus()` },
  check("source-mode move succeeds", `${A}.manageImages('./moved/red %23 renamed.svg','move',{destination:${q(path.join(moved, "source.svg"))}}).then(result=>result.count===1)`),
  { waitFor: `${A}._sourceCM.getValue().includes('./moved/source.svg')` },
  { key: "Meta+Z" },
  check("source-mode undo retains moved paths and prior text history", `${A}._sourceCM.getValue().endsWith(' + draft')&&${A}._sourceCM.getValue().includes('./moved/source.svg')`),
  { key: "Meta+Shift+Z" },
  check("source-mode redo retains moved paths", `${A}._sourceCM.getValue().endsWith(' + source edit')&&${A}._sourceCM.getValue().includes('./moved/source.svg')`),
  { eval: "window.bridge.fileOperation.undo()" },
  { waitFor: `${A}._sourceCM.getValue().includes('red%20%23%20renamed.svg')` },
  { cmd: "view.source" },
  { eval: `${A}.openFolder(${q(library)})` },
  check("folder image copies use one file for shared references", `${A}.manageImages(null,'copy',{scope:'folder',dir:${q(path.join(dir, "folder-copies"))}}).then(result=>result.count===1)`),
  { eval: "window.bridge.fileOperation.undo()" },
  check("folder image moves deduplicate shared assets", `${A}.manageImages(null,'move',{scope:'folder',dir:${q(batch)}}).then(result=>result.count===1)`),
  check("closed folder documents receive repaired image links with original line endings", `(async()=>{const a=await window.bridge.document.read({path:${q(path.join(library, "a.md"))}});const b=await window.bridge.document.read({path:${q(path.join(library, "b.md"))}});return a.text.includes("<../batch/shared red.svg> 'keep title'")&&a.text.includes('\\r\\n')&&a.text.includes(${q('`![literal](shared red.svg)`')})&&b.text.includes('../batch/shared%20red.svg')})()`),
  { eval: "window.bridge.fileOperation.undo()" },
  check("folder move undo restores both original documents byte-for-byte", `(async()=>{const a=await window.bridge.document.read({path:${q(path.join(library, "a.md"))}});const b=await window.bridge.document.read({path:${q(path.join(library, "b.md"))}});return a.text===${q(folderA)}&&b.text===${q(folderB)}})()`),
  check("batch failure leaves earlier source images in place", `(async()=>{try{await window.bridge.images.manage({operation:'move',docPath:${q(doc)},dir:${q(batch)},targets:[{url:${q(path.join(library, "shared red.svg"))}},{url:${q(path.join(library, "missing.svg"))}}]});return false}catch{return ${exists(path.join(library, "shared red.svg"))}}})()`),
  { cmd: "view.readonly" },
  check("readonly blocks image mutations and uploads in the native host", `(async()=>{let blocked=0;for(const action of [()=>window.bridge.images.manage({operation:'delete',reference:'assets/two.svg',confirmed:true}),()=>${upload("readonly.png")}])try{await action()}catch(e){if(e.message.includes('Readonly'))blocked++}return blocked===2})()`),
  { cmd: "view.readonly" },
  check("upload stays disabled until opted in", `${upload("disabled.png")}.then(result=>!result.uploaded&&!result.uploadError&&result.reference.includes('disabled.png'))`),
  { cmd: "file.preferences" },
  { eval: `document.querySelector('[data-pane=image]').click();document.getElementById('pref-extra-imageUploadOnPaste').checked=true;document.getElementById('pref-extra-imageUploader').value='command';document.getElementById('pref-extra-imageUploadConfig').value=${q("command: " + command + " {file}")};document.getElementById('preferences-done').click()` },
  { waitFor: `${A}.settings.imageUploadOnPaste===true` },
  { eval: `${E}.setText('Paste: ',{docBase:${q(doc)}});${E}.root.focus();${E}.selectOffsets(7);window.bridge.clipboard.paste({clipboard:{text:'',html:'',hasImage:true,image:{ok:true,png:${q(png)}}}})` },
  { waitFor: `${E}.getMarkdown().includes('https://images.example.test/command.png')` },
  check("pasted images use the configured command and insert its URL", `${E}.getMarkdown()`, "Paste: ![](https://images.example.test/command.png)"),
  { key: "Meta+Z" },
  check("uploaded-image insertion is undoable", `${E}.getMarkdown()`, "Paste: "),
  { eval: settings({ imageInsertDir: "./assets ' $(touch injected)", imageUploader: "upic", imageUploadOptions: { path: upic } }) },
  check("uPic uses its configured executable path and URL output", `${upload("upic.png")}.then(result=>result.uploaded&&result.reference==='https://images.example.test/upic.png')`),
  { eval: settings({ imageUploader: "command", imageUploadOptions: { command: command + " {file}" } }) },
  check("command templates quote image paths as one literal argument", `${upload("quoted name's $(touch injected).png")}.then(result=>result.uploaded&&result.reference==='https://images.example.test/command.png')`),
  { eval: settings({ imageUploader: "picgo", imageUploadOptions: { path: picgo, url: endpoint + "/picgo" } }) },
  check("PicGo starts its configured executable and uses its HTTP upload service", `${upload("picgo.png")}.then(result=>result.uploaded&&result.reference==='https://images.example.test/picgo.png')`),
  { eval: settings({ imageUploader: "http", imageUploadOptions: { url: endpoint + "/upload", fileField: "image", urlPath: "data.link", fields: { album: "demo" }, headers: { Authorization: "Bearer test-token" } } }) },
  check("HTTP uploads support form fields, headers and response paths", `${upload("http.png")}.then(result=>result.uploaded&&result.reference==='https://images.example.test/http.png')`),
  { eval: settings({ imageUploadOptions: { url: endpoint + "/slow", urlPath: "data.link" } }) },
  check("slow uploads leave native file work responsive", `(async()=>{const pending=${upload("slow.png")};const start=performance.now();await window.bridge.path.stat({path:${q(doc)}});const elapsed=performance.now()-start;return (await pending).uploaded&&elapsed<600})()`),
  { eval: settings({ imageUploader: "http", imageUploadOptions: { url: endpoint + "/invalid", urlPath: "data.link" } }) },
  check("invalid uploader URLs retain the local file", `${upload("invalid.png")}.then(async result=>!!result.uploadError&&!result.uploaded&&!!(await window.bridge.path.stat({path:result.path})))`),
  { eval: settings({ imageUploader: "command", imageUploadOptions: { command: failing + " {file}" } }) },
  { cmd: "view.source" }, { waitFor: `!!${A}._sourceCM` },
  { eval: `${A}._sourceCM.setCursor({line:0,ch:7});${A}._sourceCM.focus();window.bridge.clipboard.paste({clipboard:{text:'',html:'',hasImage:true,image:{ok:true,png:${q(png)}}}})` },
  { waitFor: `${A}._sourceCM.getValue().includes('![](')` },
  check("failed source-mode upload inserts its retained local image and reports the failure", `${A}._sourceCM.getValue().startsWith('Paste: ![](')&&document.getElementById('md-notification').textContent.includes('local image was kept')`),
  { key: "Meta+Z" },
  check("source-mode image paste is undoable", `${A}._sourceCM.getValue()`, "Paste: "),
  { cmd: "view.source" },
  { eval: `${E}.setText(${q('<img src="./moved/red%20%23%20renamed.svg" alt="Red" width="160" style="zoom:75%;" onerror="bad()">')},{docBase:${q(doc)}});${E}.root.focus();${E}.selectOffsets(${E}.getMarkdown().length)` },
  { waitFor: `!!${E}.root.querySelector('.md-img-loaded')` },
  { capture: "images-light" },
  check("HTML image exports preserve image content, dimensions and zoom", `${A}.doExport('html',${q(path.join(dir, "images.html"))})`),
  check("Word exports retain HTML image content", `${A}.doExport('docx',${q(path.join(dir, "images.docx"))})`),
  { eval: `${A}.setTheme('lettrine-dark')` }, { waitFor: "document.body.classList.contains('ui-dark')" },
  { capture: "images-dark" },
  { eval: "window.bridge.i18n.setLocale({locale:'zh-Hans'})" }, { waitFor: `${A}.i18n.locale==='zh-Hans'` },
  { assertMenu: { id: "command.images.html", property: "label", eq: "使用 HTML 图片语法", name: "image menus are localized" } },
  check("opening a local image is accepted by its default application", "window.bridge.images.open({url:'./assets/disabled.png'}).then(result=>result.ok)"),
  { focusWindow: true },
  check("no renderer errors", "window.__lettrineStartupErrors", []),
];
const scenario = path.join(dir, "scenario.json"); await writeFile(scenario, JSON.stringify(steps, null, 2));
const { executable, args } = await resolveRuntime(root, process.argv[2]);
const child = spawn(executable, [...args, "--user-data-dir=" + profile, "--lettrine-harness", scenario, "--lettrine-out", dir], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let log = ""; child.stdout.on("data", data => { log += data; }); child.stderr.on("data", data => { log += data; });
const timeout = setTimeout(() => child.kill("SIGTERM"), 180000);
let code;
try { code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); }); }
finally { clearTimeout(timeout); await new Promise(resolve => server.close(resolve)); }
await writeFile(path.join(dir, "native.log"), log); console.log("Image management report: " + dir);
const report = JSON.parse(await readFile(path.join(dir, "report.json"), "utf8"));
for (const item of report.filter(item => item.op === "assert" || item.ok === false)) console.log(`${item.ok ? "PASS" : "FAIL"} ${item.name || item.error}`);
assert.equal(code, 0, "Image management native scenario failed");
assert.equal(await readFile(doc, "utf8"), source, "The dirty open draft is never silently saved");
assert.equal(await readFile(path.join(library, "a.md"), "utf8"), folderA); assert.equal(await readFile(path.join(library, "b.md"), "utf8"), folderB);
assert.equal(await readFile(copy, "utf8"), red); assert.equal(await readFile(destination, "utf8"), red);
const argsUPic = (await readFile(path.join(dir, "upic-args.txt"), "utf8")).trim().split("\n");
assert.deepEqual(argsUPic.slice(0, 3), ["-o", "url", "-u"]); assert.ok(argsUPic[3].includes("assets ' $(touch injected)")); await access(argsUPic[3]);
await assert.rejects(access(path.join(dir, "injected")));
await assert.rejects(access(path.join(root, "injected")));
const commandArgs = (await readFile(path.join(dir, "command-args.txt"), "utf8")).trim().split("\n");
assert.equal(commandArgs.length, 1); assert.ok(commandArgs[0].includes("quoted name's $(touch injected).png")); await access(commandArgs[0]);
await access(path.join(dir, "picgo-started.txt"));
assert.deepEqual(requests.map(request => request.url), ["/picgo", "/upload", "/slow", "/invalid"]);
assert.equal(JSON.parse(requests[0].body.toString()).list.length, 1);
assert.equal(requests[1].headers.authorization, "Bearer test-token");
assert.ok(requests[1].body.includes(Buffer.from('name="image"')) && requests[1].body.includes(Buffer.from('name="album"\r\n\r\ndemo')));
assert.ok(requests[1].body.includes(Buffer.from(png, "base64")));
const exported = new JSDOM(await readFile(path.join(dir, "images.html"), "utf8")).window.document.querySelector("img");
assert.ok(exported.src.startsWith("data:image/svg+xml;base64,")); assert.equal(exported.width, 160); assert.equal(exported.getAttribute("onerror"), null); assert.match(exported.getAttribute("style"), /zoom:75%/);
const word = spawnSync("unzip", ["-l", path.join(dir, "images.docx")], { encoding: "utf8" });
assert.equal(word.status, 0); assert.match(word.stdout, /word\/media\/[^\s]+\.svg/);
const saved = JSON.parse(await readFile(path.join(profile, "settings.json"), "utf8"));
assert.equal(saved.imageUploadOnPaste, true); assert.ok(saved.imageUploadConfig.includes("{file}"));
console.log("PASS image lifecycle, file/text undo, folder reference repair, HTML syntax, zoom, upload integrations and local failure fallback");
