// Native renderer timings and process memory samples. Run alone: native
// scenarios share focus. All documents, profiles and reports are temporary.
import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntime } from "./runtime.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const directory = await mkdtemp(path.join(os.tmpdir(), "lettrine-performance-"));
const runtime = await resolveRuntime(root, process.argv[2]);
const isolatedApp = path.join(directory, "Lettrine Benchmark.app");
await cp(path.dirname(path.dirname(path.dirname(runtime.executable))), isolatedApp, { recursive: true });
const plist = path.join(isolatedApp, "Contents/Info.plist");
await writeFile(plist, (await readFile(plist, "utf8")).replace(/(<key>CFBundleIdentifier<\/key><string>)[^<]+/, `$1io.github.jasonwong2001.lettrine.benchmark.${process.pid}`));
assert.equal(spawnSync("codesign", ["--force", "--sign", "-", isolatedApp]).status, 0);
const executable = path.join(isolatedApp, "Contents/MacOS/Lettrine");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quote = JSON.stringify;
const A = "window.__lettrine";
const richSource = Array.from({ length: 40 }, (_, index) => [
  `## Section ${index}`, "A paragraph with **formatted text**.",
  "$$\n" + String.raw`\sum_{k=1}^{n} k = \frac{n(n+1)}{2}` + "\n$$",
  index % 4 === 0 ? "```mermaid\nflowchart LR\n A[Draft] --> B[Review] --> C[Publish]\n```" : "```js\nconst answer = 42;\n```",
].join("\n\n")).join("\n\n");

function processes() {
  const result = spawnSync("/bin/ps", ["-axo", "pid,ppid,rss,time,comm"], { encoding: "utf8" });
  assert.equal(result.status, 0, "Process accounting requires permission to run ps");
  return result.stdout.trim().split("\n").slice(1).flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d:.]+)\s+(.+)$/.exec(line);
    return match ? [{ pid: +match[1], parent: +match[2], rssKiB: +match[3], cpuSeconds: match[4].split(":").reduce((sum, part) => sum * 60 + Number(part), 0), name: path.basename(match[5]) }] : [];
  });
}

const setup = `(async()=>{
  const a=${A},e=a.editor;
  window.__performanceErrors=[];
  addEventListener('error',event=>__performanceErrors.push(event.message));
  addEventListener('unhandledrejection',event=>__performanceErrors.push(String(event.reason)));
  const yieldTurn=()=>new Promise(resolve=>setTimeout(resolve,32));
  const {updateWordCount}=await import('./ui.js');
  const until=async(fn)=>{const deadline=performance.now()+30000;while(!fn()){if(performance.now()>deadline)throw Error('Performance scenario timed out');await new Promise(resolve=>setTimeout(resolve,20));}};
  const quantiles=values=>{const sorted=values.slice().sort((x,y)=>x-y);return {medianMs:sorted[Math.floor(sorted.length/2)],p95Ms:sorted[Math.min(sorted.length-1,Math.ceil(sorted.length*.95)-1)]};};
  let parts=null;
  for(const name of ['setText','renderAll','getMarkdown','pushHistory','onChange']){
    const original=e[name];
    e[name]=function(...args){if(!parts)return original.apply(this,args);const start=performance.now();try{return original.apply(this,args);}finally{const entry=parts[name]||={ms:0,calls:0};entry.ms+=performance.now()-start;entry.calls++;}};
  }
  const sample=async(fn,count=12)=>{
    const sync=[],stages=[];
    for(let i=0;i<count;i++){
      parts={};const started=performance.now();await fn(i);sync.push(performance.now()-started);stages.push(parts);parts=null;
      await yieldTurn();
    }
    const inclusive={};
    for(const name of ['setText','renderAll','getMarkdown','pushHistory','onChange'])inclusive[name]={...quantiles(stages.map(stage=>stage[name]?.ms||0)),calls:stages.map(stage=>stage[name]?.calls||0)};
    return {samples:count,synchronous:quantiles(sync),inclusive};
  };
  const source=(count,variant='')=>Array.from({length:count},(_,i)=>'Paragraph '+i+variant+' — A clear workspace helps keep attention on writing. '+ 'Read and write with confidence. '.repeat(3)).join('\\n\\n');
  const reset=async(count)=>{if(a._sourceCM)a.toggleSource();e.setText(source(count));a._savedText=e.getMarkdown();a._dirty=false;updateWordCount(e);e.root.focus();e.placeCaret(count-1,e.blocks[count-1].src.length);await yieldTurn();};
  const input=()=>{
    const node=e.root.lastElementChild.querySelector('.md-plain').firstChild,s=getSelection();s.collapse(node,node.length);
    let prevented=false;e.handleBeforeInput({inputType:'insertText',data:'x',preventDefault(){prevented=true}});
    if(prevented)throw Error('Unexpected input interception');node.appendData('x');s.collapse(node,node.length);e.handleInput({inputType:'insertText'});
  };
  window.__perf={a,e,yieldTurn,until,sample,source,reset,input};
  await yieldTurn();
  a._dirty=false;await a.newDocument();
  return {userAgent:navigator.userAgent,visibility:document.visibilityState,yieldMethod:'timer between synchronous samples'};
})()`;

const plain = (count) => `(async()=>{
  const {a,e,yieldTurn,sample,source,reset,input,until}=__perf;
  // Every sample renders a different document: unchanged blocks are reused.
  const render=await sample(i=>{e.setText(source(${count},'.'+i));void e.root.offsetHeight;},3);
  await reset(${count});const typing=await sample(input);
  const format=await sample(i=>{e.root.focus();e.placeCaret(Math.floor(${count}/2)+i,10);return a.handleCommand('paragraph.h2');});
  a.toggleSource();await until(()=>!!a._sourceCM);await yieldTurn();
  const cm=a._sourceCM;cm.setCursor(cm.posFromIndex(cm.getValue().length));cm.focus();
  const sourceInput=await sample(()=>cm.replaceSelection('x','end','+input'));
  if(e.getMarkdown()!==cm.getValue())throw Error('Source/model mismatch');
  const leaveStarted=performance.now();a.toggleSource();const sourceCloseMs=performance.now()-leaveStarted;await yieldTurn();
  return {blocks:${count},characters:e.getMarkdown().length,render,typing,format,sourceInput,sourceCloseMs};
})()`;

const rich = `(async()=>{
  const {a,e,yieldTurn,until,sample}=__perf;
  const source=${quote(richSource)};
  const started=performance.now();e.setText(source);e.root.focus();e.placeCaret(1,10);await until(()=>e.root.querySelectorAll('.md-diagram svg').length===10);await yieldTurn();
  const loadMs=performance.now()-started;
  const diagram=e.root.querySelector('.md-diagram svg'),formula=e.root.querySelector('.katex');
  const format=await sample(()=>{e.root.focus();e.placeCaret(1,10);return a.handleCommand('inline.strong');},6);
  await until(()=>e.root.querySelectorAll('.md-diagram svg').length===10);
  return {blocks:e.blocks.length,formulas:e.root.querySelectorAll('.katex').length,diagrams:e.root.querySelectorAll('.md-diagram svg').length,loadMs,format,retainedDiagram:diagram===e.root.querySelector('.md-diagram svg'),retainedFormula:formula===e.root.querySelector('.katex')};
})()`;

// Structural edits in a 5,000-block document with headings and formulas.
// Each sample includes the layout it causes, since most of the work is there.
const structural = `(async()=>{
  const {a,e,yieldTurn,sample}=__perf;
  const {handleKeydown}=await import('./editor-input.js');
  const source=Array.from({length:5000},(_,i)=>(i%50===0?'## Section '+i:i%97===0?'$$\\nx^'+i+'\\n$$':'Paragraph '+i+' — A clear workspace helps keep attention on writing. '+'Read and write with confidence. '.repeat(3))).join('\\n\\n');
  e.setText(source);a._savedText=e.getMarkdown();a._dirty=false;e.root.focus();await yieldTurn();
  const laidOut=(fn)=>async(i)=>{await fn(i);void e.root.offsetHeight;};
  const enter=await sample(laidOut(i=>{e.root.focus();e.placeCaret(2501+i*3,12);handleKeydown(e,{key:'Enter',preventDefault(){}});}),8);
  const join=await sample(laidOut(i=>{e.root.focus();e.placeCaret(2700+i*3,0);handleKeydown(e,{key:'Backspace',preventDefault(){}});}),8);
  const undo=await sample(laidOut(()=>e.undo()),8);
  const redo=await sample(laidOut(()=>e.redo()),8);
  return {structuralBlocks:e.blocks.length,formulas:e.root.querySelectorAll('.katex').length,enter,join,undo,redo};
})()`;

async function run(index, full) {
  const folder = path.join(directory, `run-${index}`), profile = path.join(folder, "profile");
  await mkdir(profile, { recursive: true });
  await writeFile(path.join(profile, "settings.json"), quote({ locale: "en", background: "light", autosave: false, welcomeShown: true }));
  const marker = path.join(folder, "checkpoint.json");
  const checkpoint = (name) => [{ sleep: 800 }, { eval: `window.bridge.export.md({path:${quote(marker)},text:${quote(quote({ name }))}})` }, { sleep: 4000 }];
  const steps = [{ eval: "({wallTime:Date.now(),navigationMs:performance.now()})" }, { focusWindow: true }, { eval: setup }];
  if (full) steps.push(
    ...checkpoint("empty"),
    { eval: plain(1000) }, { eval: plain(5000) }, { eval: structural },
    ...checkpoint("long-document"),
    { eval: `(async()=>{
      const {e,reset,input,sample}=__perf;await reset(5000);
      const typing=await sample(()=>{e._historyBoundary=true;input();},200);
      const states=[...e._history,...e._future];
      const logicalCharacters=states.reduce((sum,state)=>sum+(state.textLength??state.text.length),0);
      const storedCharacters=typeof e._historyText==='string'
        ? e._historyText.length+states.reduce((sum,state)=>sum+(state.change?.inserted.length||0),0)
        : logicalCharacters;
      const current=e.getMarkdown();e.undo();
      if(e.getMarkdown()!==current.slice(0,-1))throw Error('History stress undo mismatch');
      e.redo();if(e.getMarkdown()!==current)throw Error('History stress redo mismatch');
      return {historyStates:e._history.length,logicalCharacters,storedCharacters,typing};
    })()` },
    ...checkpoint("history-201"),
    { eval: rich }, ...checkpoint("rich-document"),
    { assert: { name: "rich document has all formulas and diagrams", expr: "__perf.e.root.querySelectorAll('.katex').length===40&&__perf.e.root.querySelectorAll('.md-diagram svg').length===10&&__performanceErrors.length===0", eq: true } },
    { eval: "__perf.reset(5000)" },
    { window: "new" }, { eval: setup }, { eval: "__perf.reset(5000)" },
    { window: "new" }, { eval: setup }, { eval: "__perf.reset(5000)" },
    { window: "new" }, { eval: setup }, { eval: "__perf.reset(5000)" },
    ...checkpoint("four-windows"),
    { assert: { name: "performance scenarios finish without renderer errors", expr: "__performanceErrors", eq: [] } },
  );
  const scenario = path.join(folder, "scenario.json");
  await writeFile(scenario, quote(steps));
  const existing = new Set(processes().map((entry) => entry.pid));
  const started = Date.now();
  const child = spawn(executable, [`--user-data-dir=${profile}`, "--lettrine-harness", scenario, "--lettrine-out", folder], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let log = "", collecting = false, last = "";
  const memory = [];
  child.stdout.on("data", (chunk) => { log += chunk; }); child.stderr.on("data", (chunk) => { log += chunk; });
  const timer = setTimeout(() => child.kill("SIGTERM"), 240000);
  const poll = setInterval(async () => {
    if (collecting) return;
    collecting = true;
    try {
      const { name } = JSON.parse(await readFile(marker, "utf8"));
      if (name === last) return;
      last = name;
      const before = processes().filter((entry) => entry.pid === child.pid || !existing.has(entry.pid) && /^com\.apple\.WebKit\./.test(entry.name));
      assert.ok(before.some((entry) => entry.pid === child.pid), "The benchmark host must be present in the memory sample");
      const file = path.join(folder, `memory-${name}.json`);
      const footprint = spawnSync("/usr/bin/footprint", [...before.flatMap((entry) => ["-p", String(entry.pid)]), "--noCategories", "-f", "bytes", "-j", file], { encoding: "utf8", timeout: 10000 });
      let accounting = null;
      if (footprint.status === 0) accounting = JSON.parse(await readFile(file, "utf8"));
      const idleBefore = processes().filter((entry) => before.some((previous) => previous.pid === entry.pid));
      const idleStarted = Date.now(); await delay(2000); const after = processes();
      const cpuSeconds = idleBefore.reduce((sum, entry) => sum + Math.max(0, (after.find((next) => next.pid === entry.pid)?.cpuSeconds ?? entry.cpuSeconds) - entry.cpuSeconds), 0);
      memory.push({ name, processes: before, footprintBytes: accounting?.["total footprint"] ?? null, accounting: accounting?.processes ?? [], idleCPUPercent: cpuSeconds / ((Date.now() - idleStarted) / 1000) * 100 });
      console.log(`Sampled ${name}: ${memory.at(-1).footprintBytes === null ? "memory unavailable" : (memory.at(-1).footprintBytes / 1048576).toFixed(1) + " MiB"}`);
    } catch (error) { if (error.code !== "ENOENT") console.error(error.message); }
    finally { collecting = false; }
  }, 100);
  let code;
  try { code = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); }); }
  finally { clearTimeout(timer); clearInterval(poll); }
  while (collecting) await delay(50);
  await writeFile(path.join(folder, "native.log"), log);
  assert.equal(code, 0, `Performance scenario failed; see ${folder}`);
  const report = JSON.parse(await readFile(path.join(folder, "report.json"), "utf8"));
  const evaluations = report.filter((entry) => entry.op === "eval").map((entry) => entry.value);
  const startupMs = evaluations[0].wallTime - started;
  console.log(`Fresh-process renderer ready: ${startupMs} ms`);
  return { startupMs, evaluations, memory };
}

console.log(`Performance report: ${directory}`);
const runs = [await run(1, true), await run(2, false), await run(3, false)];
const result = { measuredAt: new Date().toISOString(), platform: os.platform(), architecture: os.arch(), macOS: spawnSync("/usr/bin/sw_vers", ["-productVersion"], { encoding: "utf8" }).stdout.trim(), node: process.version, cpu: os.cpus()[0].model, memoryBytes: os.totalmem(), runs };
await writeFile(path.join(directory, "summary.json"), JSON.stringify(result, null, 2));
for (const value of runs[0].evaluations) {
  if (value?.render) console.log(JSON.stringify({ blocks: value.blocks, render: value.render.synchronous, typing: value.typing.synchronous, format: value.format.synchronous, sourceInput: value.sourceInput.synchronous, sourceCloseMs: value.sourceCloseMs }));
  if (value?.historyStates) console.log(JSON.stringify({ historyStates: value.historyStates, logicalCharacters: value.logicalCharacters, storedCharacters: value.storedCharacters, typing: value.typing.synchronous, historyPush: { medianMs: value.typing.inclusive.pushHistory.medianMs, p95Ms: value.typing.inclusive.pushHistory.p95Ms } }));
  if (value?.diagrams) console.log(JSON.stringify(value));
  if (value?.structuralBlocks) console.log(JSON.stringify({ blocks: value.structuralBlocks, formulas: value.formulas, enter: value.enter.synchronous, join: value.join.synchronous, undo: value.undo.synchronous, redo: value.redo.synchronous }));
}
