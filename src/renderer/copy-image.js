import { escapeHtml } from "../core/inline.js";
import { equationTex, equationTrust } from "../core/math.js";

const ATOM = ".md-inline-math, .md-math-block, .md-image, .md-smart, pre.md-fences:has(.CodeMirror), pre.md-fences.md-diagram-ready";
const elementOf = (node) => node?.nodeType === 1 ? node : node?.parentElement;

// Keep the ancestors of a partial selection: cloneContents alone loses the
// bold/heading/list styling when both endpoints are inside the same element.
function cloneSelection(range, root) {
  let fragment = range.cloneContents();
  for (let node = elementOf(range.commonAncestorContainer); node && node !== root; node = node.parentElement) {
    const wrapper = node.cloneNode(false);
    wrapper.appendChild(fragment);
    fragment = wrapper;
  }
  const container = document.createElement("div");
  container.appendChild(fragment);
  return container;
}

export function renderedSelection(editor, selection) {
  const range = selection.getRangeAt(0).cloneRange();
  const start = elementOf(range.startContainer)?.closest(ATOM);
  const end = elementOf(range.endContainer)?.closest(ATOM);
  // Formulas and images are atomic; never copy a few KaTeX glyph spans or a
  // CodeMirror textarea in place of their rendered content.
  if (start && editor.root.contains(start)) range.setStartBefore(start);
  if (end && editor.root.contains(end)) range.setEndAfter(end);
  const copy = cloneSelection(range, editor.root);
  const lists = Array.from(editor.root.querySelectorAll("ol")).filter((list) => range.intersectsNode(list));
  Array.from(copy.querySelectorAll("ol")).forEach((list, index) => {
    const original = lists[index];
    const first = original && Array.from(original.children).findIndex((item) => range.intersectsNode(item));
    if (first >= 0) list.start = original.start + first;
  });
  const blocks = new Map(editor.blocks.map((block) => [block._cid, block]));
  for (const node of copy.querySelectorAll("[data-cid]")) {
    const block = blocks.get(node.dataset.cid);
    if (node.matches(".md-math-block")) {
      const body = node.querySelector(".md-math-body");
      if (block && body && node.querySelector(".CodeMirror") && window.katex) window.katex.render(equationTex(block.tex, editor._equations, editor._equations?.byBlock.get(block)), body, { throwOnError: false, displayMode: true, output: "html", trust: equationTrust });
    } else if (node.matches("pre.md-fences")) {
      const diagram = node.querySelector(".md-diagram");
      if (diagram?.querySelector("svg, .katex")) {
        const figure = document.createElement("figure");
        figure.className = "md-diagram";
        figure.dataset.diagram = diagram.dataset.diagram;
        if (diagram.dataset.diagram === "math") figure.dataset.tex = block?.body ?? diagram.dataset.tex;
        figure.append(...diagram.childNodes);
        node.replaceWith(figure);
      } else {
        const code = node.querySelector(".md-code-body");
        if (code) {
          if (block && node.querySelector(".CodeMirror")) code.textContent = block.body;
          code.style.removeProperty("display");
        }
      }
    }
  }
  for (const node of copy.querySelectorAll(".md-image.md-img-error")) node.replaceWith(document.createTextNode(node.textContent));
  for (const node of copy.querySelectorAll(".md-footnote")) {
    if (!node.querySelector(".md-fn-num")?.textContent) node.replaceWith(document.createTextNode(node.textContent));
  }
  for (const node of copy.querySelectorAll(".md-attr, .CodeMirror, .md-mathblock-panel, .md-lang, .md-sep-row, .app-table-row-controls, .app-table-column-controls, .md-frontmatter, .md-math-block > .md-plain, .md-inline-math.md-rendered > .md-tex-src, .md-image:has(img) > .md-plain, .md-fn-marker, .md-footnote > .md-text")) node.remove();
  for (const node of copy.querySelectorAll("[contenteditable], [tabindex]")) {
    node.removeAttribute("contenteditable"); node.removeAttribute("tabindex");
  }
  for (const node of copy.querySelectorAll(".md-focus, .ic-contain-cm, .md-diagram-ready, .md-smart-editing")) {
    node.classList.remove("md-focus", "ic-contain-cm", "md-diagram-ready", "md-smart-editing");
  }
  return copy.innerHTML;
}

export function imageCopyPayload(app, target) {
  const editor = app.editor, root = editor.root;
  const style = window.getComputedStyle(root);
  const width = root.getBoundingClientRect().width - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
  const payload = { width: Math.max(160, Math.min(4096, width || 796)), theme: app.theme, dark: document.body.classList.contains("ui-dark"), docPath: app.file };
  const formula = target?.closest?.(".md-inline-math, .md-math-block");
  if (formula) {
    const display = formula.classList.contains("md-math-block");
    const block = display && editor.blocks.find((block) => block._cid === formula.dataset.cid);
    const tex = display ? block?.tex ?? formula.querySelector(".md-math-body")?.dataset.tex : formula.dataset.tex;
    const range = document.createRange(); range.selectNode(formula);
    return { ...payload, tight: true, text: display ? `$$\n${tex || ""}\n$$` : `$${tex || ""}$`, fragment: renderedSelection(editor, { getRangeAt: () => range }) };
  }
  const diagram = target?.closest?.(".md-diagram");
  if (diagram) {
    const block = editor.blocks.find((block) => block._cid === diagram.closest("[data-cid]")?.dataset.cid);
    return { ...payload, text: block?.src || "```" + (diagram.dataset.diagram || "mermaid") + "\n" + diagram.dataset.tex + "\n```" };
  }

  if (document.body.classList.contains("sourceview-on")) {
    const cm = app._sourceCM, textarea = document.getElementById("source-editor");
    const text = cm ? cm.getSelection() : textarea.value.slice(textarea.selectionStart, textarea.selectionEnd);
    if (text) return { ...payload, text };
  } else {
    const mounted = editor._activeCmBlock();
    if (mounted) {
      const block = editor.blocks[mounted.index];
      if (block?.type === "math") return { ...payload, tight: true, text: block.src };
      if (mounted.cm.somethingSelected()) return { ...payload, fragment: `<pre><code>${escapeHtml(mounted.cm.getSelection())}</code></pre>` };
    } else {
      const selection = window.getSelection();
      if (selection?.rangeCount && !selection.isCollapsed && root.contains(selection.anchorNode) && root.contains(selection.focusNode)) {
        return { ...payload, fragment: renderedSelection(editor, selection) };
      }
      const math = elementOf(selection?.anchorNode)?.closest(".md-inline-math, .md-math-block");
      if (math && root.contains(math)) return imageCopyPayload(app, math);
    }
  }
  const rect = document.getElementById("md-content").getBoundingClientRect();
  const x = Math.max(0, rect.left), y = Math.max(0, rect.top);
  return { region: { x, y, width: Math.min(window.innerWidth, rect.right) - x, height: Math.min(window.innerHeight, rect.bottom) - y } };
}
