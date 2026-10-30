import { linkMarkdown } from "../core/links.js";

// Convert a detached clipboard fragment. Active content and document chrome
// are discarded; only the supported Markdown structure reaches the model.
export function htmlToMarkdown(html, doc = document, settings = {}) {
  const template = doc.createElement("template");
  template.innerHTML = html;
  const text = (node) => Array.from(node.childNodes).map(convert).join("");
  const escape = (value) => value.replace(settings.subscriptSuperscript ? /[\\`*_[\]<>~^]/g : /[\\`*_[\]<>]/g, "\\$&");
  const convert = (node) => {
    if (node.nodeType === 3) return escape(node.data.replace(/[\t\n\r ]+/g, " "));
    if (node.nodeType !== 1) return "";
    const tag = node.tagName.toLowerCase();
    if (["script", "style", "noscript", "iframe", "object", "head", "button", "input"].includes(tag) || node.classList.contains("md-decor") || node.classList.contains("md-attr")) return "";
    if (tag === "pre") {
      const source = node.textContent.replace(/\n$/, "");
      const fence = "`".repeat(Math.max(3, ...Array.from(source.matchAll(/`+/g), (match) => match[0].length + 1)));
      const lang = /(?:^|\s)language-([^\s]+)/.exec(node.firstElementChild?.className || "")?.[1] || "";
      return `\n\n${fence}${lang}\n${source}\n${fence}\n\n`;
    }
    if (tag === "table") {
      const rows = Array.from(node.querySelectorAll("tr")).map((row) => Array.from(row.children).filter((cell) => /^(TD|TH)$/.test(cell.tagName)).map((cell) => text(cell).trim().replace(/\|/g, "\\|")));
      if (!rows.length || !rows[0].length) return "";
      const row = (cells) => "| " + cells.join(" | ") + " |";
      const header = Array.from(node.querySelector("tr").children);
      const sep = rows[0].map((_, i) => header[i]?.style.textAlign === "center" ? ":---:" : header[i]?.style.textAlign === "right" ? "---:" : "---");
      return "\n\n" + [row(rows[0]), row(sep), ...rows.slice(1).map(row)].join("\n") + "\n\n";
    }
    if (tag === "ul" || tag === "ol") {
      let number = Number(node.getAttribute("start")) || 1;
      const lines = Array.from(node.children).filter((child) => child.tagName === "LI").map((item) => {
        const content = text(item).trim().replace(/\n{3,}/g, "\n\n");
        const marker = tag === "ol" ? `${number++}. ` : "- ";
        return marker + content.replace(/\n/g, "\n" + " ".repeat(marker.length));
      });
      return "\n\n" + lines.join("\n") + "\n\n";
    }
    const content = text(node);
    if (/^h[1-6]$/.test(tag)) return "\n\n" + "#".repeat(Number(tag[1])) + " " + content.trim() + "\n\n";
    if (["strong", "b"].includes(tag)) return "**" + content + "**";
    if (["em", "i"].includes(tag)) return "*" + content + "*";
    if (["s", "del", "strike"].includes(tag)) return "~~" + content + "~~";
    if (tag === "code") { const fence = "`".repeat(Math.max(1, ...Array.from(node.textContent.matchAll(/`+/g), (m) => m[0].length + 1))); return fence + node.textContent + fence; }
    if (tag === "a") {
      const href = node.getAttribute("href") || "";
      return href && !/^(javascript|vbscript|data):/i.test(href) ? linkMarkdown(content, href, node.getAttribute("title") || "").source : content;
    }
    if (tag === "img") {
      const src = node.getAttribute("src") || "";
      return !src || /^(javascript|vbscript):/i.test(src) ? "" : "!" + linkMarkdown(node.getAttribute("alt") || "", src).source;
    }
    if (tag === "blockquote") return "\n\n" + content.trim().split("\n").map((line) => "> " + line).join("\n") + "\n\n";
    if (tag === "u") return "<u>" + content + "</u>";
    if (tag === "sub" || tag === "sup") return settings.subscriptSuperscript ? `<${tag}>` + content + `</${tag}>` : content;
    if (tag === "br") return "  \n";
    if (tag === "hr") return "\n\n---\n\n";
    if (["p", "div", "section", "article"].includes(tag)) return "\n\n" + content.trim() + "\n\n";
    return content;
  };
  return text(template.content).replace(/\n{3,}/g, "\n\n").trim();
}
