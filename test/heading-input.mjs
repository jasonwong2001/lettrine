// Observe the caret during native input and its first frame, before the brush.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { resolveRuntime } from "./runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dir = await mkdtemp(path.join(os.tmpdir(), "lettrine-heading-input-")), profile = path.join(dir, "profile");
await mkdir(profile);
await writeFile(path.join(profile, "settings.json"), JSON.stringify({ autosave: false, restoreSession: false, locale: "en", background: "light" }));
const A = "window.__lettrine", E = `${A}.editor`, q = JSON.stringify;
const check = (name, expr, eq = true) => ({ assert: { name, expr, eq } });
const steps = [
  { focusWindow: true },
  { eval: `window.__headingFrames=[];window.__headingErrors=[];addEventListener('error',e=>__headingErrors.push(e.message));
    window.__headingSnapshot=(phase)=>{
      const editor=${E},selection=getSelection(),heading=editor.root.querySelector('h1,h2,h3,h4,h5,h6');
      if(!heading||!heading.classList.contains('md-simple-empty'))return;
      const marker=heading.querySelector('.md-tag'),caret=selection.rangeCount?selection.getRangeAt(0).getBoundingClientRect():null;
      const end=document.createRange();end.selectNodeContents(marker);const edge=end.getBoundingClientRect();
      __headingFrames.push({phase,source:editor.getMarkdown(),offset:editor.caretInfo().offset,textAnchor:selection.anchorNode?.nodeType===3,
        visible:getComputedStyle(marker).display!=='none',caretHeight:caret?.height||0,dx:caret?Math.abs(caret.left-edge.right):null});
    };
    for(const name of ['handleInput','handleBeforeInput']){
      const original=${E}[name];${E}[name]=function(event){
        const result=original.call(this,event);
        if(event.data==='#'&&(name==='handleInput'||event.defaultPrevented)){
          __headingSnapshot('input');requestAnimationFrame(()=>__headingSnapshot('frame'));
        }
        return result;
      };
    }` },
];
for (const autoPairMarkdown of [false, true]) {
  steps.push(
    { eval: `window.bridge.setting.put({key:'__patch',value:{autoPairMarkdown:${autoPairMarkdown},autoExpandSimple:true}})` },
    { eval: `${E}.setText('');${E}.root.focus();${E}.selectOffsets(0);window.__headingFrames=[]` },
    { type: "#", wait: 0 },
    { waitFor: "__headingFrames.some(frame=>frame.phase==='frame')" },
    check(`heading input with marker completion ${autoPairMarkdown}: the caret is visible in its first input and frame`, "(()=>{const frames=__headingFrames;return frames.length>=2&&frames.every(frame=>frame.textAnchor&&frame.visible&&frame.caretHeight>0&&frame.dx<2)?true:frames;})()"),
  );
  steps.push(
    { type: "##", wait: 0 },
    check(`heading input with marker completion ${autoPairMarkdown}: repeated markers keep the caret after the prefix`, `(()=>{
      const source=${E}.getMarkdown(),caret=${E}.caretInfo();
      return source===${q(autoPairMarkdown ? "### " : "###")}&&caret.offset===${autoPairMarkdown ? 4 : 3}?true:{source,caret,html:${E}.root.innerHTML};
    })()`),
    { type: " Heading", wait: 0 },
    check(`heading input with marker completion ${autoPairMarkdown}: title typing retains exact source`, `${E}.getMarkdown()`, "### Heading"),
    { key: "Enter" }, { type: "Body", wait: 0 },
    check(`heading input with marker completion ${autoPairMarkdown}: Enter continues in a paragraph`, `${E}.getMarkdown()`, "### Heading\n\nBody"),
    { key: "Meta+Z" },
    check(`heading input with marker completion ${autoPairMarkdown}: typing remains undoable`, `${E}.getMarkdown()`, "### Heading\n\n"),
  );
}
steps.push(check("heading input produces no renderer errors", "__headingErrors", []));
const scenario = path.join(dir, "scenario.json");
await writeFile(scenario, JSON.stringify(steps, null, 2));
const { executable, args } = await resolveRuntime(root, process.argv[2]);
const child = spawn(executable, [...args, "--user-data-dir=" + profile, "--lettrine-harness", scenario, "--lettrine-out", dir], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
let log = "";
child.stdout.on("data", (data) => { log += data; }); child.stderr.on("data", (data) => { log += data; });
const timeout = setTimeout(() => child.kill("SIGTERM"), 45000);
const code = await new Promise((resolve, reject) => { child.once("exit", resolve); child.once("error", reject); });
clearTimeout(timeout);
await writeFile(path.join(dir, "native.log"), log);
console.log("Heading input report: " + dir);
const report = JSON.parse(await readFile(path.join(dir, "report.json"), "utf8"));
for (const item of report.filter((item) => item.op === "assert" || item.ok === false)) console.log(`${item.ok ? "PASS" : "FAIL"} ${item.name || item.error}`);
assert.equal(code, 0, "Native heading input scenario failed");
assert.deepEqual(JSON.parse(await readFile(path.join(dir, "external-actions.json"), "utf8")), []);
