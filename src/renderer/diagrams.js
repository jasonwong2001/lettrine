import { diagramLanguage, diagramSource } from "../core/diagrams.js";
import { equationTex, equationTrust, fenceEquation } from "../core/math.js";

const loading = new Map(), registered = new WeakSet(), configurations = new WeakMap();
let queue = Promise.resolve(), identity = 0;
function loadScript(url, available, message) {
  if (available()) return Promise.resolve(available());
  if (loading.has(url)) return loading.get(url);
  const pending = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    let timer, settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      loading.delete(url);
      if (error) { script.remove(); reject(Error(message)); }
      else resolve(available());
    };
    script.src = url;
    script.onload = () => finish(!available());
    script.onerror = () => finish(true);
    timer = setTimeout(() => finish(true), 10000); timer.unref?.();
    document.head.appendChild(script);
  });
  loading.set(url, pending);
  return pending;
}

export const diagramOptions = (app = window.__lettrine, dark = app?._darkAppearance) => ({
  dark: !!dark,
  fontFamily: app?.settings?.fontFamily || (document.getElementById("write") ? window.getComputedStyle(document.getElementById("write")).fontFamily : "") || "sans-serif",
  equations: app?.editor?._equations,
});

function presentZenUML(html, body, options) {
  const fragment = document.createElement("template"); fragment.innerHTML = html;
  const svg = fragment.content.querySelector("svg"), dimensions = svg?.getAttribute("viewBox")?.trim().split(/\s+/).map(Number);
  if (!dimensions || dimensions.length !== 4 || !(dimensions[2] > 0 && dimensions[3] > 0)) throw Error("Invalid diagram syntax.");
  // The upstream parser recovers some invalid declarations as placeholders.
  // Keep their source visible rather than presenting them as finished diagrams.
  const missing = "Missing `Participant`";
  if (!body.includes(missing) && [...svg.querySelectorAll(".participant-label")].some((node) => node.textContent.trim() === missing)) throw Error("Invalid diagram syntax.");
  const palette = { "#ffffff": "#202226", "#fff": "#202226", "#222": "#e2e4e8", "#000": "#e2e4e8", "#666": "#969ca5", "#dedede": "#41454d", "#e5e7eb": "#59616b", "#fff5ad": "#4e451f", "#aaaa33": "#b1a15a", "#333": "#d2d6dc", "#6b7280": "#a9b0bb" };
  for (const style of svg.querySelectorAll("style")) if (style.textContent.includes(".frame-border-inner")) {
    let css = style.textContent;
    if (options.dark) css = css.replace(/#[\da-f]{3,6}\b/gi, (color) => palette[color.toLowerCase()] || color);
    style.textContent = css.replace(/(^|})\s*([^{}]+)\{/g, (_, before, selectors) => before + selectors.split(",").map((selector) => "#" + svg.id + " " + selector.trim()).join(",") + "{");
  }
  if (options.dark) for (const node of svg.querySelectorAll("[fill], [stroke]")) for (const attribute of ["fill", "stroke"]) {
    const value = node.getAttribute(attribute);
    if (palette[value?.toLowerCase()]) node.setAttribute(attribute, palette[value.toLowerCase()]);
  }
  for (const text of svg.querySelectorAll("text")) text.style.fontFamily = options.fontFamily || "sans-serif";
  return fragment.innerHTML;
}

export async function renderFenceDiagram(info, body, options = {}) {
  const language = diagramLanguage(info);
  if (language === "math") {
    if (!window.katex) throw Error("The math renderer is unavailable.");
    return { html: window.katex.renderToString(equationTex(body, options.equations, fenceEquation(body)), {
      throwOnError: true, displayMode: true, output: options.mathOutput || "htmlAndMathml", trust: equationTrust,
    }) };
  }
  const render = async () => {
    const styles = language === "zenuml" ? new Set(document.head.querySelectorAll("style")) : null;
    try {
      const mermaid = await loadScript("../../node_modules/mermaid/dist/mermaid.min.js", () => window.mermaid, "The diagram renderer is unavailable.");
      if (language === "zenuml" && !registered.has(mermaid)) {
        const plugin = await loadScript("../../node_modules/@mermaid-js/mermaid-zenuml/dist/mermaid-zenuml.min.js", () => window["mermaid-zenuml"], "The ZenUML renderer is unavailable.");
        await mermaid.registerExternalDiagrams([plugin]);
        registered.add(mermaid);
      }
      const config = { startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: options.dark ? "dark" : "neutral", fontFamily: options.fontFamily || "sans-serif" };
      const signature = JSON.stringify(config);
      if (configurations.get(mermaid) !== signature) { mermaid.initialize(config); configurations.set(mermaid, signature); }
      const result = await mermaid.render("md-diagram-" + ++identity, diagramSource(language, body));
      return { html: language === "zenuml" ? presentZenUML(result.svg, body, options) : result.svg, bindFunctions: result.bindFunctions };
    } finally {
      if (styles) {
        // Its standalone UI injects global resets; native SVG carries its own
        // styles and must not change the surrounding document or app chrome.
        for (const style of document.head.querySelectorAll("style")) if (!styles.has(style) && style.textContent.includes(".zenuml .sequence-diagram")) style.remove();
      }
    }
  };
  // Mermaid has global configuration and a shared rendering surface. Keep
  // theme changes and export jobs in the same sequence as preview rendering.
  const pending = queue.then(render);
  queue = pending.catch(() => {});
  return pending;
}

export function diagramError(error, translate = (text) => text) {
  const message = error?.message || "";
  return translate("Diagram could not be rendered.") + (message ? " " + translate(message) : "");
}
