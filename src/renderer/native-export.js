// Standalone exports run in the existing WebKit document and hand finished
// HTML to AppKit/PDFKit. No server-side Node runtime is needed in the bundle.
import { parseBlocks } from "../core/blocks.js";
import { parseInline, escapeHtml } from "../core/inline.js";
import { headingSlug } from "../core/links.js";
import { tocOptions } from "../core/toc.js";
import { ALERT_LABELS, alertIcon, alertMarker } from "../core/alerts.js";
import { smartPunctuation, rendersSmartPunctuation } from "../core/typography.js";
import { equationIndex, equationTex, equationTrust } from "../core/math.js";
import { imageHTML } from "../core/image-tag.js";
import { diagramLanguage } from "../core/diagrams.js";
import { renderFenceDiagram, diagramOptions, diagramError } from "./diagrams.js";

let markdownReady;
function markdownIt() {
  if (window.markdownit) return Promise.resolve(window.markdownit);
  return markdownReady ||= new Promise((resolve, reject) => {
    const script = document.createElement("script"); script.src = "../../node_modules/markdown-it/dist/markdown-it.min.js";
    script.onload = () => resolve(window.markdownit); script.onerror = () => reject(new Error("The Markdown export library could not be loaded")); document.head.appendChild(script);
  });
}
const asset = (url, docPath) => window.bridge.native.invoke("native.asset", { url, docPath });
const dataURI = (resource) => `data:${resource.mime.split(";")[0]};base64,${resource.data}`;

export async function embedHTMLImages(html, docPath) {
  const fragment = document.createElement("template");
  fragment.innerHTML = html;
  await Promise.all(Array.from(fragment.content.querySelectorAll("img[src]")).map(async (image) => {
    const source = image.getAttribute("src");
    if (!source || source.startsWith("data:")) return;
    try { image.src = dataURI(await asset(source, docPath)); }
    catch { /* A remote image retains its original URL. */ }
  }));
  return fragment.innerHTML;
}

// Import qualifiers wrap the imported rules in the same order as CSS:
// layer, supports, then media. Balance parentheses so nested conditions
// and quoted strings keep their original meaning.
function importedCSS(css, qualifiers) {
  let rest = qualifiers.trim();
  const wrappers = [];
  const takeFunction = (name) => {
    const open = new RegExp("^" + name + "\\s*\\(", "i").exec(rest);
    if (!open) return null;
    let depth = 1, quote = "";
    for (let i = open[0].length; i < rest.length; i++) {
      const ch = rest[i];
      if (ch === "\\") { i++; continue; }
      if (quote) { if (ch === quote) quote = ""; continue; }
      if (ch === "'" || ch === '"') { quote = ch; continue; }
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (!depth) {
        const value = rest.slice(open[0].length, i);
        rest = rest.slice(i + 1).trim();
        return value;
      }
    }
    return null;
  };
  const layer = takeFunction("layer");
  if (layer !== null) wrappers.push("@layer " + layer);
  else if (/^layer(?:\s|$)/i.test(rest)) { wrappers.push("@layer"); rest = rest.slice(5).trim(); }
  const supports = takeFunction("supports");
  if (supports !== null) wrappers.push("@supports " + (/^[\w-]+\s*:/.test(supports) ? "(" + supports + ")" : supports));
  if (rest) wrappers.push("@media " + rest);
  return wrappers.reduceRight((content, wrapper) => `${wrapper}{\n${content}\n}`, css);
}

async function embeddedCSS(url, depth = 0) {
  if (!url) return "";
  const resource = await asset(url);
  let css = (resource.text || "").replace(/@import\s+(?:url\()?['"]?https?:[^;]+;/gi, "");
  // A local @import (lettrine-dark.css builds on lettrine.css) is inlined in place.
  const imports = await Promise.all([...css.matchAll(/@import\s+(?:url\(\s*(['"]?)([^'"()\s;]+)\1\s*\)|(['"])([^'"]+)\3)\s*([^;]*);/gi)].map(async ([statement, , urlSource, , quotedSource, qualifiers]) => {
    const source = urlSource || quotedSource;
    if (depth > 4 || /^(data:|https?:)/i.test(source)) return [statement, ""];
    try { return [statement, importedCSS(await embeddedCSS(new URL(source, resource.url).href, depth + 1), qualifiers)]; }
    catch { return [statement, ""]; }
  }));
  for (const [statement, replacement] of imports) css = css.split(statement).join(replacement);
  const replacements = await Promise.all([...css.matchAll(/url\((['"]?)([^'"()]+)\1\)/g)].map(async ([original, , source]) => {
    if (/^(data:|https?:|#)/i.test(source)) return [original, original];
    try { return [original, `url("${dataURI(await asset(new URL(source, resource.url).href))}")`]; }
    catch { return [original, original]; }
  }));
  for (const [original, replacement] of replacements) css = css.split(original).join(replacement);
  return css;
}

export async function buildNativeExport(options = {}) {
  const MarkdownIt = await markdownIt(), app = window.__lettrine;
  const settings = options.settings || app?.settings || {}, markdown = options.text || "", blocks = parseBlocks(markdown);
  const equations = equationIndex(blocks, settings);
  const notes = new Map(), headings = [], images = new Set(), imageData = new Map();
  const keyOf = (ref) => ref.trim().toLocaleLowerCase();
  const inlineRefs = (source) => {
    const visit = (parts) => { for (const part of parts) {
      if (part.type === "footnote") { const key = keyOf(part.ref); if (!notes.has(key)) notes.set(key, { number: notes.size + 1, count: 0 }); notes.get(key).count++; }
      if (part.type === "image") images.add(part.url);
      if (Array.isArray(part.inner)) visit(part.inner);
      else if (["bold", "italic", "strike", "highlight", "underline", "subscript", "superscript", "link"].includes(part.type) && typeof part.inner === "string") visit(parseInline(part.inner, settings));
    } };
    visit(parseInline(source, settings));
  };
  const collect = (items, top = true) => { for (const block of items) {
    if (block.type === "heading" && top) headings.push(block);
    if (block.type === "quote") collect(block.items, false);
    else if (block.type === "def_footnote") inlineRefs(block.text || "");
    else if (block.type === "list") { const visit = (list) => { for (const item of list) { inlineRefs(item.text || ""); visit(item.children || []); } }; visit(block.items); }
    else if (block.type === "table") for (const row of [block.headers, ...block.rows]) for (const cell of row) inlineRefs(cell);
    else if (!["code", "math", "html", "toc", "hr", "frontmatter"].includes(block.type)) inlineRefs(block.src);
  } };
  collect(blocks);
  for (const reference of images) {
    if (!reference || reference.startsWith("data:")) continue;
    try { imageData.set(reference, dataURI(await asset(reference, options.docPath || app?.file))); }
    catch { /* Remote URLs retain their original reference. */ }
  }
  const headingCounts = new Map(), renderCounts = new Map(), referenceCounts = new Map();
  const ids = headings.map((heading) => { const slug = headingSlug(heading.text), n = headingCounts.get(slug) || 0; headingCounts.set(slug, n + 1); return slug + (n ? "-" + n : ""); });
  const md = new MarkdownIt({ html: false, linkify: true, breaks: settings.preserveBreaks !== false });
  md.core.ruler.before("text_join", "lettrine-punctuation", (state) => {
    if (!rendersSmartPunctuation(settings)) return;
    for (const block of state.tokens) {
      if (block.type !== "inline") continue;
      const tokens = block.children || [];
      for (let index = 0; index < tokens.length; index++) if (tokens[index].type === "text") {
        tokens[index].content = smartPunctuation(tokens[index].content, settings, tokens.slice(0, index).map((t) => t.content).join(""), tokens.slice(index + 1).map((t) => t.content).join(""));
      }
    }
  });
  md.core.ruler.after("block", "lettrine-alerts", (state) => {
    for (let i = 0; i < state.tokens.length; i++) {
      const open = state.tokens[i], paragraph = state.tokens[i + 1], content = state.tokens[i + 2];
      if (open.type !== "blockquote_open" || paragraph?.type !== "paragraph_open" || content?.type !== "inline") continue;
      const alert = alertMarker(content.content);
      if (!alert) continue;
      open.attrJoin("class", "md-alert md-alert-" + alert.type);
      content.content = content.content.slice(alert.prefix.length);
      const title = new state.Token("html_block", "", 0);
      const label = app?.i18n?.strings?.[ALERT_LABELS[alert.type]] || ALERT_LABELS[alert.type];
      title.content = `<div class="md-alert-title">${alertIcon(alert.type)}<span>${escapeHtml(label)}</span></div>\n`;
      if (!content.content) state.tokens.splice(i + 1, 3, title);
      else state.tokens.splice(i + 1, 0, title);
    }
  });
  const renderMath = (tex, display = false, equation = null) => settings.renderMath === false ? `<code>${escapeHtml(tex)}</code>`
    : window.katex.renderToString(equationTex(tex, equations, equation), { throwOnError: false, displayMode: display, trust: equationTrust, output: options.style === false ? "mathml" : "htmlAndMathml" });
  md.inline.ruler.before("escape", "lettrine-script-space", (state, silent) => {
    if (!state.env?._script || state.src[state.pos] !== "\\" || !/[ \t]/.test(state.src[state.pos + 1] || "")) return false;
    if (!silent) state.push("text", "", 0).content = state.src[state.pos + 1];
    state.pos += 2; return true;
  });
  md.inline.ruler.before("escape", "lettrine-inline", (state, silent) => {
    if (!["$", "\\", "[", ":", "=", "<", "~", "^"].includes(state.src[state.pos])) return false;
    const part = parseInline(state.src.slice(state.pos), settings)[0];
    if (!part || !["math", "footnote", "emoji", "highlight", "underline", "subscript", "superscript", "htmlBreak"].includes(part.type) && !(part.type === "image" && part.syntax === "html")) return false;
    if (!silent) {
      const token = state.push("html_inline", "", 0);
      if (part.type === "htmlBreak") token.content = "<br>";
      else if (part.type === "image") token.content = imageHTML({ ...part, url: imageData.get(part.url) || part.url });
      else if (part.type === "math") token.content = renderMath(part.tex);
      else if (part.type === "emoji") token.content = escapeHtml(part.char);
      else if (part.type === "highlight") token.content = "<mark>" + md.renderInline(part.src.slice(2, -2), state.env) + "</mark>";
      else if (part.type === "underline") token.content = "<u>" + md.renderInline(part.inner, state.env) + "</u>";
      else if (part.type === "subscript" || part.type === "superscript") {
        const tag = part.type === "subscript" ? "sub" : "sup";
        token.content = `<${tag}>` + md.renderInline(part.inner, { ...state.env, _script: true }) + `</${tag}>`;
      }
      else {
        const ref = keyOf(part.ref), note = notes.get(ref), number = note?.number || part.ref;
        const count = (referenceCounts.get(ref) || 0) + 1; referenceCounts.set(ref, count);
        token.content = `<sup id="fnref-${encodeURIComponent(ref)}-${count}"><a href="#fn-${encodeURIComponent(ref)}">${escapeHtml(String(number))}</a></sup>`;
      }
    }
    state.pos += part.src.length; return true;
  });
  md.renderer.rules.heading_open = (tokens, index, opts, env, renderer) => {
    const slug = headingSlug(tokens[index + 1].content), count = renderCounts.get(slug) || 0;
    if (tokens[index].level === 0) { renderCounts.set(slug, count + 1); tokens[index].attrSet("id", slug + (count ? "-" + count : "")); }
    return renderer.renderToken(tokens, index, opts);
  };
  const image = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, index, opts, env, renderer) => { const token = tokens[index], reference = token.attrGet("src"); if (imageData.has(reference)) token.attrSet("src", imageData.get(reference)); return image(tokens, index, opts, env, renderer); };
  const diagrams = [];
  const fence = md.renderer.rules.fence;
  md.renderer.rules.fence = (tokens, index, opts, env, renderer) => {
    const token = tokens[index], language = diagramLanguage(token.info);
    if (language && (language === "math" ? settings.renderMath !== false : settings.renderDiagrams !== false)) {
      const id = diagrams.push({ language, body: token.content }) - 1;
      return `<figure class="md-diagram" data-diagram="${language}" data-export-fence="${id}"><pre><code>${escapeHtml(token.content)}</code></pre></figure>`;
    }
    return fence(tokens, index, opts, env, renderer);
  };
  const renderExportBlock = (block) => {
    if (block.type === "frontmatter") return "";
    if (block.type === "math") {
      const equation = equations.byBlock.get(block);
      return `<div class="md-math-block" id="${equation.id}">${renderMath(block.tex, true, equation)}</div>`;
    }
    if (block.type === "quote") {
      const label = app?.i18n?.strings?.[ALERT_LABELS[block.alert]] || ALERT_LABELS[block.alert];
      const title = block.alert ? `<div class="md-alert-title">${alertIcon(block.alert)}<span>${escapeHtml(label)}</span></div>` : "";
      const content = block.items.map((item, i) => {
        if (!block.alert || i !== 0) return renderExportBlock(item);
        return md.render(item.src.slice(alertMarker(item.src)?.prefix.length || 0));
      }).join("\n");
      return `<blockquote${block.alert ? ` class="md-alert md-alert-${block.alert}"` : ""}>${title}${content}</blockquote>`;
    }
    if (block.type === "def_footnote") {
      const ref = keyOf(block.ref), note = notes.get(ref);
      const backlinks = Array.from({ length: note?.count || 0 }, (_, i) => `<a href="#fnref-${encodeURIComponent(ref)}-${i + 1}" aria-label="Back to reference ${i + 1}">↩</a>`).join(" ");
      return `<aside class="footnote" id="fn-${encodeURIComponent(ref)}">${note ? `<sup>${note.number}</sup> ` : ""}${md.renderInline(block.text || "")} ${backlinks}</aside>`;
    }
    if (block.type === "toc") {
      const { width, depth } = tocOptions(block.pattern);
      return `<nav class="md-toc"${width ? ` style="width:${width}"` : ""}>${headings.map((heading, index) => heading.level > depth ? "" : `<div style="padding-left:${(heading.level - 1) * 16}px"><a href="#${escapeHtml(ids[index])}">${md.renderInline(heading.text)}</a></div>`).join("")}</nav>`;
    }
    const html = md.render(block.src);
    return block.type === "heading" && settings.ignoreHeadingBreaks ? html.replace(/<br\s*\/?>/gi, " ") : html;
  };
  let body = blocks.map(renderExportBlock).join("\n");
  if (options.fragment != null) {
    body = await embedHTMLImages(options.fragment, options.docPath || app?.file);
  } else if (diagrams.length) {
    const fragment = document.createElement("template"); fragment.innerHTML = body;
    const presentation = { ...diagramOptions(app, options.dark ?? app?._darkAppearance), equations,
      fontFamily: settings.fontFamily || diagramOptions(app).fontFamily, mathOutput: options.style === false ? "mathml" : "htmlAndMathml" };
    await Promise.all(Array.from(fragment.content.querySelectorAll("[data-export-fence]")).map(async (node) => {
      const diagram = diagrams[Number(node.dataset.exportFence)]; node.removeAttribute("data-export-fence");
      try { node.innerHTML = (await renderFenceDiagram(diagram.language, diagram.body, presentation)).html; }
      catch (error) {
        const hint = document.createElement("p"); hint.className = "md-diagram-error"; hint.textContent = diagramError(error, app?.i18nT); node.appendChild(hint);
      }
    }));
    body = fragment.innerHTML;
  }
  const theme = await window.bridge.theme.resolve({ name: options.theme || app?.theme || "lettrine" });
  const width = ({ narrow: 640, medium: 860, wide: 1100 })[settings.pageWidth] || 860;
  const css = options.style === false ? "" : (await Promise.all(["lettrine://app/src/renderer/styles/base.css", theme.theme, theme.baseOverride, theme.override, "lettrine://app/node_modules/katex/dist/katex.min.css", ...(options.image ? ["lettrine://app/src/renderer/styles/editor.css"] : [])].map((url) => embeddedCSS(url).catch(() => "")))).join("\n")
    + `\nhtml,body{margin:0;height:auto;overflow:visible}html{font-size:${Math.max(10, Math.min(48, Number(settings.fontSize) || 14))}px}body{padding:36px 24px;background:var(--bg-color,#fff);color:var(--text-color,#333)}#write{max-width:${width}px;line-height:${Math.max(1, Math.min(3, Number(settings.lineHeight) || 1.6))};font-family:${String(settings.fontFamily || "inherit").replace(/[{};<>\r\n]/g, "")};margin:auto;padding:0;position:static;min-height:0;width:auto}img,svg{max-width:100%;height:auto}table{border-collapse:collapse}th,td{border:1px solid #ccc;padding:5px 10px}.footnote{font-size:.9em}.katex-display{overflow:auto}.md-diagram{margin:1em 0}.md-diagram svg{display:block;margin:auto}.md-diagram-error{white-space:pre-wrap}@media print{body{padding:0}pre,tr,img,svg{break-inside:avoid}a{color:inherit;text-decoration:none}}`
    + (options.image ? `\nbody{padding:16px}#write.md-image-export{display:flow-root;max-width:none;min-height:0;margin:0;padding:0!important;width:${options.tight ? "max-content" : "auto"}}#write .katex-display{overflow:visible}#write .md-frontmatter{display:none}#write.md-image-export pre{overflow:visible}.md-image-export .md-math-block>.md-plain{display:none}` : "");
  const writingCSS = options.style === false ? "" : `${settings.indentFirstLine ? "#write p{text-indent:2em}" : ""}${settings.wrapCode === false ? "#write pre{white-space:pre;overflow-x:auto}" : ""}${settings.ignoreHeadingBreaks ? "#write :is(h1,h2,h3,h4,h5,h6){white-space:normal}" : ""}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escapeHtml(options.title || "Markdown document")}</title>${css ? `<style>${(css + writingCSS).replace(/<\/style/gi, "<\\/style")}</style>` : ""}</head><body${(options.dark ?? app?._darkAppearance) ? ' class="ui-dark"' : ""}><article id="write" class="md-export${options.image ? " md-image-export" : ""}">${body}</article></body></html>`;
}
