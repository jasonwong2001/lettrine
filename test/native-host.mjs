// Migration-specific native contracts: marked-text commits and queued saves
// through parent-folder removal/restoration. Temporary documents only.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, realpath } from 'node:fs/promises';
import { watch } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { resolveRuntime } from './runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = await mkdtemp(path.join(os.tmpdir(), 'lettrine-native-host-'));
const parent = path.join(dir, 'folder'), doc = path.join(parent, 'nested.md');
await mkdir(parent); await mkdir(path.join(dir, 'profile'));
await writeFile(doc, '# Parent folder\n\nOriginal content\n');
const watched = path.join(dir, 'watched.md'), signal = path.join(dir, 'external-trigger.md'), indexed = path.join(dir, 'new-indexed.md');
const canonicalIndexed = path.join(await realpath(dir), 'new-indexed.md');
await writeFile(watched, 'Before external update');
const app = 'window.__lettrine', editor = app + '.editor';
const check = (name, expr, eq = true) => ({ assert: { name, expr, eq } });
const steps = [
  { sleep: 250 },
  check('harness arguments remain outside the document', `${app}.file`, null),
  { eval: `window.__imeEvents=[];for(const name of ['compositionstart','compositionupdate','compositionend'])document.addEventListener(name,e=>__imeEvents.push(e.type));${editor}.setText('**bold** ');${editor}.root.focus();${editor}.selectOffsets(9)` },
  { compose: { marked: ['z', 'zh', 'zhong'], text: '中文' } },
  check('native marked text commits once after styled text', `${editor}.getMarkdown()`, '**bold** 中文'),
  check('the native input client emits composition events', "__imeEvents.includes('compositionstart')&&__imeEvents.filter(e=>e==='compositionend').length===1"),
  { cmd: 'edit.undo' }, check('one undo restores the pre-composition source', `${editor}.getMarkdown()`, '**bold** '),
  { cmd: 'edit.redo' }, check('one redo restores the committed Chinese', `${editor}.getMarkdown()`, '**bold** 中文'),
  { type: '。' },
  check('typing continues after a native IME commit', `${editor}.getMarkdown()`, '**bold** 中文。'),
  { cmd: 'view.source' }, { waitFor: `!!${app}._sourceCM` },
  { eval: `${app}._sourceCM.setCursor(${app}._sourceCM.posFromIndex(${app}._sourceCM.getValue().length));${app}._sourceCM.focus()` },
  { compose: { marked: ['s', 'shu', 'shuru'], text: '输入' } },
  check('source mode retains native marked text', `${app}._sourceCM.getValue()`, '**bold** 中文。输入'),
  { cmd: 'view.source' },
  { eval: `${editor}.setText('clipboard text');${editor}.root.focus();${editor}.selectOffsets(0,9)` },
  { key: 'Meta+X' }, check('native Cut updates the Markdown model', `${editor}.getMarkdown()`, ' text'),
  { key: 'Meta+Z' }, check('native Cut is undoable', `${editor}.getMarkdown()`, 'clipboard text'),
  { eval: `${editor}.setText('');${editor}.root.focus();${editor}.selectOffsets(0)` },
  { key: 'Meta+V' }, check('cut content reaches the system clipboard', `${editor}.getMarkdown()`, 'clipboard'),
  { eval: `${editor}.setText('');${editor}.root.focus();window.bridge.clipboard.write({text:'瞬时剪贴板中文'})` },
  { key: 'Meta+V', wait: 0 }, { eval: "window.bridge.clipboard.write({text:'restored clipboard'})" },
  check('preview pastes the clipboard captured at the native key event', `${editor}.getMarkdown()`, '瞬时剪贴板中文'),
  { cmd: 'view.source' }, { waitFor: `!!${app}._sourceCM` },
  { eval: `${app}._sourceCM.setValue('source input');${app}._sourceCM.setSelection({line:0,ch:0},{line:0,ch:6});${app}._sourceCM.focus()` },
  { key: 'Meta+C' }, { eval: `${app}._sourceCM.setCursor({line:0,ch:12})` }, { key: 'Meta+V' },
  check('native Copy works in CodeMirror input', `${app}._sourceCM.getValue()`, 'source inputsource'),
  { eval: `${app}._sourceCM.setValue('');${app}._sourceCM.focus();window.bridge.clipboard.write({text:'源码中文粘贴'})` },
  { key: 'Meta+V', wait: 0 }, { eval: "window.bridge.clipboard.write({text:'restored clipboard'})" },
  check('source mode pastes the captured clipboard as one commit', `${app}._sourceCM.getValue()`, '源码中文粘贴'),
  { cmd: 'view.source' },
  { eval: `${app}._dirty=false` }, { open: doc },
  { tab: 'new' },
  { eval: `window.bridge.library.trashItem({path:${JSON.stringify(parent)}})` },
  { assertDocuments: { name: 'trashing a parent closes its open document tabs', paths: [null] } },
  check('a queued save cannot recreate a trashed parent', `(async()=>{try{await window.bridge.document.write({path:${JSON.stringify(doc)},text:'stale',followRenames:true});return false;}catch(e){return e.message.includes('deleted');}})()`),
  { cmd: 'file.undo' }, { open: doc }, { waitFor: `${app}.file===${JSON.stringify(doc)}` },
  check('undo restores the exact nested document path', `${editor}.docBase`, doc),
  { eval: `${editor}.root.focus();${editor}.selectOffsets(${editor}.getMarkdown().length)` },
  { type: 'Restored' }, { save: true },
  check('the restored parent accepts an acknowledged save', `(async()=>{const r=await window.bridge.document.read({path:${JSON.stringify(doc)}});return r.text.endsWith('Restored');})()`),
  check('Markdown export succeeds through the native host', `(async()=>{const r=await window.bridge.export.md({path:${JSON.stringify(path.join(dir, 'export.md'))},text:${editor}.getMarkdown()});return r.ok;})()`),
  { open: watched },
  { eval: `window.__diskEvents=[];window.bridge.on('doc.diskChanged',value=>__diskEvents.push(value));window.bridge.quickOpen.query({scope:${JSON.stringify(dir)},text:'new-indexed'})` },
  { tab: 'new' },
  { eval: `window.bridge.export.md({path:${JSON.stringify(signal)},text:'ready'})` },
  { sleep: 1200 }, { switch: -1 },
  { waitFor: "__diskEvents.some(event=>event.size===0)&&!!document.querySelector('#confirm-choice-btns button[data-choice=\"Reload\"]')" },
  { click: '#confirm-choice-btns button[data-choice="Reload"]' },
  { waitFor: `${app}.file===${JSON.stringify(watched)}&&${editor}.getMarkdown()===''`, diagnostic: `({file:${app}.file,source:${editor}.getMarkdown(),visibility:document.visibilityState,focused:document.hasFocus(),active:document.activeElement.outerHTML,dialogs:[...document.querySelectorAll('.modal.open')].map(node=>node.textContent),errors:window.__lettrineStartupErrors})` },
  check('atomic external replacement reaches a background document, including empty files', '__diskEvents.some(event=>event.size===0)'),
  { key: 'Meta+Z' }, check('external reload preserves the previous source on the undo timeline', `${editor}.getMarkdown()`, 'Before external update'),
  { key: 'Meta+Shift+Z' },
  { waitFor: `(async()=>{const files=await window.bridge.quickOpen.query({scope:${JSON.stringify(dir)},text:'new-indexed'});return files.some(file=>file.path===${JSON.stringify(indexed)});})()` },
  check('external folder changes invalidate the native file index', `(async()=>{const files=await window.bridge.quickOpen.query({scope:${JSON.stringify(dir)},text:'new-indexed'});return files.some(file=>file.path===${JSON.stringify(indexed)});})()`),
  { eval: `window.bridge.quickOpen.cacheRecentFiles({paths:[${JSON.stringify(canonicalIndexed)}]})` },
  check('Quick Open deduplicates canonical and caller-spelled paths', `(async()=>{const files=await window.bridge.quickOpen.query({scope:${JSON.stringify(dir)},text:'new-indexed'});return files.length;})()`, 1),
];
const scenario = path.join(dir, 'scenario.json'); await writeFile(scenario, JSON.stringify(steps, null, 2));
const { executable, args } = await resolveRuntime(root, process.argv[2]);
let externalChange, mutationError;
const watcher = watch(dir, (_, name) => {
  if (name !== path.basename(signal) || externalChange) return;
  externalChange = (async () => {
    await writeFile(watched + '.tmp', ''); await rename(watched + '.tmp', watched);
    await writeFile(indexed, '# Indexed externally');
  })().catch(error => { mutationError = error; });
});
const child = spawn(executable, [...args, '--user-data-dir=' + path.join(dir, 'profile'), '--lettrine-harness', scenario, '--lettrine-out', dir], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
const timeout = setTimeout(() => child.kill('SIGTERM'), 60000);
const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }); clearTimeout(timeout);
watcher.close(); await externalChange; if (mutationError) throw mutationError;
await writeFile(path.join(dir, 'native.log'), log); console.log('Native host report: ' + dir);
const report = JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8'));
for (const item of report.filter(item => item.op === 'assert' || item.ok === false)) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name || item.error}`);
assert.equal(code, 0, 'Native host migration contracts failed');
assert.match(await readFile(doc, 'utf8'), /Original content\nRestored$/);
assert.equal(await readFile(path.join(dir, 'export.md'), 'utf8'), await readFile(doc, 'utf8'));
