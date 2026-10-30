// Exercise the native renderer's standalone export path, including local
// assets, diagrams, math and multiple printed pages.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { JSDOM } from 'jsdom';
import { PDFDocument, PDFName } from 'pdf-lib';
import { resolveRuntime } from './runtime.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = await mkdtemp(path.join(os.tmpdir(), 'lettrine-native-export-'));
await mkdir(path.join(dir, 'profile/themes'), { recursive: true });
await writeFile(path.join(dir, 'profile/themes/lettrine.user.css'), '#write{letter-spacing:.15px}');
await writeFile(path.join(dir, 'profile/themes/conditional.css'), '@import "print.css" print;\n@import "screen.css" screen;\n@import "layer.css" layer(theme) supports(display: grid) screen;\n#write{color:rgb(12,34,56)}');
await writeFile(path.join(dir, 'profile/themes/print.css'), '#write p{letter-spacing:9px}');
await writeFile(path.join(dir, 'profile/themes/screen.css'), '#write p{word-spacing:3px}');
await writeFile(path.join(dir, 'profile/themes/layer.css'), '#write p{text-indent:7px}');
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="70"><rect width="160" height="70" rx="8" fill="#eef2f8"/><text x="12" y="40" fill="#304060">Local asset</text></svg>';
await writeFile(path.join(dir, 'local image.svg'), svg);
const text = ['---\ntitle: Metadata stays out of the body\n---', '# Native export 中文', '[TOC]', '## Math and assets', '$$\nE = mc^2\n$$', 'Inline $x^2$ and ==highlight==, a note[^one] and another[^one].', '> [!WARNING]\n> Keep <u>**source**</u> unchanged.', '<u>Underlined paragraph</u>', '![local](local%20image.svg)', '```mermaid\ngraph LR\n A[Markdown] --> B[PDF]\n```', '[^one]: Footnote 中文', '<script>window.__unsafeExport = true</script>', '## Long document', ...Array.from({ length: 65 }, (_, i) => `Paragraph ${i + 1}. Native WebKit export retains readable text, page margins and document structure. 中文内容保持完整。`)].join('\n\n');
const doc = path.join(dir, 'export-source.md'), htmlPath = path.join(dir, 'document.html'), pdfPath = path.join(dir, 'document.pdf'), darkPath = path.join(dir, 'document-dark.html');
await writeFile(doc, text);
const A = 'window.__lettrine', check = (name, expr, eq = true) => ({ assert: { name, expr, eq } });
const steps = [
  { open: doc },
  { eval: "window.__exportErrors=[];addEventListener('error',e=>__exportErrors.push(e.message));window.bridge.setting.put({key:'__patch',value:{autosave:false,fontSize:16}})" },
  check('standalone HTML export succeeds', `(async()=>{const r=await window.bridge.export.html({path:${JSON.stringify(htmlPath)},text:${A}.editor.getMarkdown(),docPath:${JSON.stringify(doc)},theme:'lettrine',title:'Native export 中文'});return r.ok;})()`),
  check('paginated PDF export succeeds', `(async()=>{const r=await window.bridge.export.pdf({path:${JSON.stringify(pdfPath)},text:${A}.editor.getMarkdown(),docPath:${JSON.stringify(doc)},theme:'lettrine',title:'Native export 中文',author:'Native 作者',pageSize:'Letter',marginTop:.5,marginBottom:.5,marginLeft:.5,marginRight:.5,displayHeaderFooter:true,pdfHeader:'Native '+String.fromCharCode(36)+'{pageNo}/'+String.fromCharCode(36)+'{totalPages}',pdfFooter:'Footer '+String.fromCharCode(36)+'{pageNo} of '+String.fromCharCode(36)+'{totalPages}'});return r.ok;})()`),
  check('standalone HTML export with the default dark theme succeeds', `(async()=>{const r=await window.bridge.export.html({path:${JSON.stringify(darkPath)},text:'# Dark export',docPath:${JSON.stringify(doc)},theme:'lettrine-dark',title:'Dark export'});return r.ok;})()`),
  { eval: `(async()=>{const result=await window.bridge.export.html({text:'Conditional CSS',theme:'conditional'});const parsed=new DOMParser().parseFromString(result.html,'text/html');const host=document.createElement('div');host.id='conditional-export';document.body.appendChild(host);const shadow=host.attachShadow({mode:'open'});for(const style of parsed.querySelectorAll('style'))shadow.appendChild(document.importNode(style,true));shadow.appendChild(document.importNode(parsed.querySelector('article'),true));return true;})()` },
  check('print imports remain inactive on screen after export', "getComputedStyle(document.getElementById('conditional-export').shadowRoot.querySelector('p')).letterSpacing", 'normal'),
  check('screen imports remain active after export', "getComputedStyle(document.getElementById('conditional-export').shadowRoot.querySelector('p')).wordSpacing", '3px'),
  check('layer and supports qualifiers remain active after export', "getComputedStyle(document.getElementById('conditional-export').shadowRoot.querySelector('p')).textIndent", '7px'),
  { eval: "document.getElementById('conditional-export').remove()" },
  check('export preserves the opened document source', `${A}.editor.getMarkdown()`, text),
  check('export leaves no renderer errors', '__exportErrors', []),
];
const scenario = path.join(dir, 'scenario.json'); await writeFile(scenario, JSON.stringify(steps, null, 2));
const { executable, args } = await resolveRuntime(root, process.argv[2]);
const child = spawn(executable, [...args, '--user-data-dir=' + path.join(dir, 'profile'), '--lettrine-harness', scenario, '--lettrine-out', dir], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', data => { log += data; }); child.stderr.on('data', data => { log += data; });
const timeout = setTimeout(() => child.kill('SIGTERM'), 90000);
const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }); clearTimeout(timeout);
await writeFile(path.join(dir, 'native.log'), log); console.log('Native export report: ' + dir);
const report = JSON.parse(await readFile(path.join(dir, 'report.json'), 'utf8'));
for (const item of report.filter(item => item.op === 'assert' || item.ok === false)) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name || item.error}`);
assert.equal(code, 0, 'Native standalone export failed');
const html = await readFile(htmlPath, 'utf8'), dom = new JSDOM(html), document = dom.window.document;
assert.equal(document.querySelector('img').src, 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
assert.equal(document.querySelectorAll('.katex').length, 2);
assert.equal(document.querySelectorAll('.md-toc a').length, 3);
assert.equal(document.querySelectorAll('.footnote a').length, 2);
assert.equal(document.querySelector('.md-alert-warning .md-alert-title').textContent, 'Warning');
assert.ok(document.querySelector('.md-alert-warning u strong'));
assert.equal(document.querySelectorAll('u').length, 2);
assert.ok(document.querySelector('.md-diagram svg'));
assert.equal(document.querySelectorAll('script').length, 0);
assert.match(html, /data:font\/woff2;base64,/);
assert.match(html, /letter-spacing:.15px/);
assert.match(html, /&lt;script&gt;window\.__unsafeExport/);
assert.doesNotMatch(document.querySelector('article').textContent, /Metadata stays out of the body/);
// lettrine-dark.css imports lettrine.css; the export inlines both
const darkHtml = await readFile(darkPath, 'utf8');
assert.doesNotMatch(darkHtml, /@import/);
assert.match(darkHtml, /--doc-heading/);
assert.match(darkHtml, /--bg-color: #1c1d20/);
const bytes = await readFile(pdfPath), pdf = await PDFDocument.load(bytes);
assert.equal(pdf.getTitle(), 'Native export 中文'); assert.equal(pdf.getAuthor(), 'Native 作者');
assert.ok(pdf.getPageCount() > 1 && pdf.getPageCount() < 15, 'Long document has a bounded, nontrivial page count');
assert.ok(bytes.length < 5 * 1024 * 1024, 'PDF contains actual content without runaway empty pages');
for (const [index, page] of pdf.getPages().entries()) {
  assert.equal(page.getWidth(), 612); assert.equal(page.getHeight(), 792);
  const annotations = page.node.Annots().asArray().map(ref => pdf.context.lookup(ref));
  const contents = annotations.map(annotation => annotation.get(PDFName.of('Contents'))?.decodeText?.() || '');
  assert.ok(contents.includes(`Footer ${index + 1} of ${pdf.getPageCount()}`));
  assert.ok(contents.includes(`Native ${index + 1}/${pdf.getPageCount()}`));
}
console.log(`PASS standalone assets, math, TOC, footnotes, safe HTML and ${pdf.getPageCount()}-page Letter PDF`);
