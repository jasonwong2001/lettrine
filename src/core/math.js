// The inner editor owns TeX only. A delimiter typed on its own line ends
// editing; a delimiter already stored in the block is appended exactly once.
export function mathInput(block, value, forceClose = false) {
  const opening = (block.src || "$$").split("\n")[0];
  const closer = opening.trim() === "\\(" ? "\\)" : "$$";
  const lines = String(value).replace(/\r\n?/g, "\n").split("\n");
  const end = lines.findIndex((line) => line.trim() === closer);
  if (end >= 0) {
    return {
      source: [opening, ...lines.slice(0, end + 1)].join("\n"),
      tail: lines.slice(end + 1).join("\n"),
      closedByInput: true,
    };
  }
  const closing = block.closed ? block.src.split("\n").at(-1) : closer;
  return {
    source: opening + "\n" + lines.join("\n") + (block.closed || forceClose ? "\n" + closing : ""),
    tail: "",
    closedByInput: false,
  };
}

// Read only commands we own, skipping escaped backslashes and TeX comments.
// Balanced arguments allow tags such as \tag{\text{A.1}} without rewriting TeX.
function mathCommands(tex) {
  const commands = [];
  for (let i = 0; i < tex.length;) {
    if (tex[i] === "%") { const end = tex.indexOf("\n", i); i = end < 0 ? tex.length : end + 1; continue; }
    if (tex[i] !== "\\") { i++; continue; }
    const start = i++, name = /^[A-Za-z]+/.exec(tex.slice(i))?.[0];
    if (!name) { i++; continue; }
    i += name.length;
    if (!["label", "eqref", "ref", "tag", "notag", "nonumber"].includes(name)) continue;
    if (name === "notag" || name === "nonumber") { commands.push({ name, start, end: i }); continue; }
    const star = name === "tag" && tex[i] === "*";
    if (star) i++;
    while (/\s/.test(tex[i] || "") && i < tex.length) i++;
    if (tex[i] !== "{") continue;
    const from = ++i;
    let depth = 1;
    while (i < tex.length && depth) {
      if (tex[i] === "\\") { i += 2; continue; }
      if (tex[i] === "{") depth++;
      if (tex[i] === "}") depth--;
      if (depth) i++;
    }
    if (!depth) commands.push({ name, start, end: ++i, value: tex.slice(from, i - 1), star });
  }
  return commands;
}

const textTex = (text) => "\\text{" + String(text).replace(/[\\#$%&_{}^~]/g, (ch) => ({
  "\\": "\\textbackslash{}", "^": "\\textasciicircum{}", "~": "\\textasciitilde{}",
}[ch] || "\\" + ch)) + "}";

export function equationIndex(blocks, settings = {}) {
  const equations = [], labels = new Map(), byBlock = new Map(), byId = new Map();
  let number = 0;
  const visit = (items) => { for (const block of items) {
    if (block.type === "quote") visit(block.items || []);
    if (block.type !== "math") continue;
    const commands = mathCommands(block.tex || "");
    const attribute = /^\s*\$\$\s*\{(.+)\}\s*$/.exec(block.src.split("\n")[0])?.[1].trim();
    const tag = commands.find((command) => command.name === "tag");
    const names = commands.filter((command) => command.name === "label").map((command) => command.value.trim()).filter(Boolean);
    if (attribute?.startsWith("#")) names.unshift(attribute.slice(1));
    const unnumbered = ["-", ".unnumbered"].includes(attribute) || commands.some((command) => command.name === "notag" || command.name === "nonumber");
    const manual = attribute && !attribute.startsWith("#") && !unnumbered ? textTex(attribute) : tag?.value;
    const eligible = block.closed && !!block.tex.trim() && !unnumbered;
    const tagTex = !eligible ? null : manual ?? (settings.numberEquations !== false ? textTex(++number) : null);
    const entry = { block, id: "md-equation-" + (equations.length + 1), tag: tagTex, star: manual === tag?.value && !!tag?.star, labels: names };
    equations.push(entry); byBlock.set(block, entry); byId.set(entry.id, entry);
    for (const label of names) if (!labels.has(label)) labels.set(label, entry);
  } };
  visit(blocks);
  return { equations, labels, byBlock, byId };
}

export function fenceEquation(tex) {
  return equationIndex([{ type: "math", src: "$$\n" + tex + "\n$$", tex, closed: true }], { numberEquations: false }).equations[0];
}

export function equationTex(tex, index, equation = null, { links = true, pandoc = false } = {}) {
  let output = "", from = 0;
  for (const command of mathCommands(tex)) {
    output += tex.slice(from, command.start);
    if (command.name === "eqref" || command.name === "ref") {
      const target = index?.labels.get(command.value.trim()), tag = target?.tag ?? textTex("??");
      const value = command.name === "eqref" ? "(" + tag + ")" : tag;
      output += target?.tag != null && links ? "\\href{#" + target.id + "}{" + value + "}" : value;
    }
    from = command.end;
  }
  output += tex.slice(from);
  if (equation?.tag != null) {
    if (pandoc) output += "\n\\qquad " + (equation.star ? equation.tag : "(" + equation.tag + ")");
    else output += "\n\\tag" + (equation.star ? "*" : "") + "{" + equation.tag + "}";
  }
  return output;
}

// Only generated, same-document equation anchors may opt into KaTeX links.
export const equationTrust = (context) => context.command === "\\href" && /^#md-equation-\d+$/.test(context.url || "");
