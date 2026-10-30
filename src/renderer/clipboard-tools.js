import { markdownSpans } from "../core/selection.js";
import { equationIndex, equationTex, equationTrust, fenceEquation } from "../core/math.js";
import { readableMarkdown } from "../core/readable.js";
import { escapeHtml } from "../core/inline.js";
import { editingContext } from "./selection-tools.js";
import { renderedSelection } from "./copy-image.js";
import { buildNativeExport, embedHTMLImages } from "./native-export.js";

function currentSpan(spans, selection, type) {
  return spans.filter((span) => span.block.type === type && selection.start >= span.start && selection.end <= span.end)
    .sort((a, b) => a.end - a.start - (b.end - b.start))[0];
}
function formulaOf(app, context, spans, target) {
  const formula = target?.closest?.(".md-inline-math, .md-math-block, .md-diagram[data-diagram=math]");
  if (formula) {
    if (formula.classList.contains("md-inline-math")) return { tex: formula.dataset.tex || "", display: false, index: app.editor._equations };
    if (formula.dataset.diagram === "math") {
      const pre = formula.closest("pre"), block = pre && app.editor.blocks[app.editor.blockIndexOfNode(pre)];
      const tex = pre?.__cm?.getValue() ?? block?.body ?? formula.dataset.tex ?? "";
      return { tex, display: true, index: app.editor._equations, equation: fenceEquation(tex) };
    }
    const entry = app.editor._equations?.byId.get(formula.id);
    const block = entry?.block || formula.__block;
    return { tex: formula.__cm?.getValue() ?? block?.tex ?? "", display: true, index: app.editor._equations, equation: entry };
  }
  const block = currentSpan(spans.nested, context.selection, "math"), index = equationIndex(spans.tree, app.settings);
  if (block) return { tex: block.block.tex, display: true, index, equation: index.byBlock.get(block.block) };
  const code = currentSpan(spans.nested, context.selection, "code");
  if (code?.block.info?.toLowerCase() === "math") return { tex: code.block.body, display: true, index, equation: fenceEquation(code.block.body) };
  const inline = spans.inline.find((span) => span.kind === "math" && context.selection.start >= span.start && context.selection.end <= span.end);
  return inline ? { tex: inline.part.tex, display: false, index } : null;
}
export function mathMLOf(formula) {
  if (!window.katex) throw Error("The math renderer is unavailable.");
  const html = window.katex.renderToString(equationTex(formula.tex, formula.index, formula.equation), {
    output: "mathml", displayMode: formula.display, throwOnError: true, trust: equationTrust,
  });
  const fragment = document.createElement("template"); fragment.innerHTML = html;
  const math = fragment.content.querySelector("math");
  if (!math) throw Error("The formula could not be converted to MathML.");
  return math.outerHTML;
}

// The pasteboard fragment keeps semantic HTML and MathML, while theme CSS,
// editing controls and active content stay in the document that owns them.
export function cleanClipboardHTML(html) {
  const parsed = new window.DOMParser().parseFromString(html, "text/html");
  const root = parsed.querySelector("article#write") || parsed.body;
  for (const node of root.querySelectorAll("script,style,link,meta,iframe,object,embed,form,button,input,textarea,select")) node.remove();
  for (const node of root.querySelectorAll(".mermaid")) {
    const pre = parsed.createElement("pre"), code = parsed.createElement("code");
    code.textContent = node.textContent; pre.appendChild(code); node.replaceWith(pre);
  }
  const allowed = new Set(["href", "src", "alt", "title", "width", "height", "colspan", "rowspan", "start", "type", "reversed", "xmlns", "display", "encoding",
    "mathvariant", "mathsize", "mathcolor", "mathbackground", "displaystyle", "scriptlevel", "stretchy", "symmetric", "fence", "separator", "lspace", "rspace",
    "accent", "accentunder", "columnalign", "rowalign", "columnspacing", "rowspacing", "columnlines", "rowlines", "linethickness", "notation", "bevelled", "maxsize", "minsize",
    "depth", "voffset", "movablelimits", "largeop", "form", "columnspan", "subscriptshift", "superscriptshift", "columnwidth", "equalcolumns", "equalrows",
    "viewBox", "d", "fill", "stroke", "stroke-width", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "points", "transform", "role"]);
  for (const node of root.querySelectorAll("*")) for (const attr of [...node.attributes]) {
    if (!allowed.has(attr.name) || /^(?:href|src)$/i.test(attr.name) && /^\s*(?:javascript|vbscript):/i.test(attr.value)) node.removeAttribute(attr.name);
  }
  return root.innerHTML.trim();
}

export async function specialCopyPayload(app, mode, target) {
  const context = editingContext(app);
  if (!context) return null;
  const { editor, text, selection, source, mounted } = context, spans = markdownSpans(text, app.settings);
  if (mode === "tex" || mode === "mathml") {
    const formula = formulaOf(app, context, spans, target);
    if (!formula) throw Error("Place the caret in a formula.");
    if (mode === "tex") return { text: formula.tex };
    const mathml = mathMLOf(formula);
    return { text: mathml, html: mathml };
  }
  if (mode === "code" || mode === "table") {
    const type = mode === "code" ? "code" : "table", node = target?.closest?.(type === "code" ? "pre[mdtype=fences]" : "[mdtype=table]");
    const index = node ? editor.blockIndexOfNode(node) : -1;
    const block = node ? (editor.blocks[index]?.type === type ? editor.blocks[index] : node.__block) : currentSpan(spans.nested, selection, type)?.block;
    if (!block) throw Error(type === "code" ? "Place the caret in a code block." : "Place the caret in a table.");
    return { text: type === "code" ? node?.__cm?.getValue() ?? block.body : block.src };
  }
  const selected = selection.start !== selection.end, markdown = selected ? text.slice(selection.start, selection.end) : text;
  let html;
  if (!source && mounted && selected) html = `<pre><code>${escapeHtml(mounted.cm.getSelection())}</code></pre>`;
  else if (!source && selected && window.getSelection()?.rangeCount) {
    html = renderedSelection(editor, window.getSelection());
    const fragment = document.createElement("template"); fragment.innerHTML = html;
    for (const formula of fragment.content.querySelectorAll(".md-inline-math, .md-math-block, .md-diagram[data-diagram=math]")) {
      const original = formula.classList.contains("md-inline-math") || formula.dataset.diagram === "math" ? formula : editor.root.querySelector("#" + formula.id);
      const data = formulaOf(app, context, spans, original);
      if (data) { const node = document.createElement("template"); node.innerHTML = mathMLOf(data); formula.replaceWith(node.content); }
    }
    html = fragment.innerHTML;
  } else html = await buildNativeExport({ text: markdown, style: false, theme: app.theme, docPath: app.file, settings: app.settings });
  return { text: readableMarkdown(markdown, app.settings), html: cleanClipboardHTML(await embedHTMLImages(html, app.file)) };
}

export async function copySpecial(app, mode, target) {
  try {
    const payload = await specialCopyPayload(app, mode, target);
    if (!payload) return false;
    await window.bridge.clipboard.write(payload);
    app.notify?.("Copied");
    return true;
  } catch (error) {
    app.notify?.(app.i18nT?.(error.message) || error.message, [], { kind: "error" });
    return false;
  }
}
