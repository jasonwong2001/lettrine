export const DIAGRAM_LANGUAGES = ["mermaid", "sequence", "flow", "flowchart", "gantt", "zenuml", "mindmap", "pie", "math"];
export const diagramLanguage = (info) => {
  const language = String(info || "").trim().toLowerCase();
  return DIAGRAM_LANGUAGES.includes(language) ? language : "";
};

export function diagramSource(language, body) {
  if (language === "mermaid" || language === "math") return body;
  const header = { sequence: "sequenceDiagram", flow: "flowchart", flowchart: "flowchart" }[language] || language;
  const existing = /^\s*(sequenceDiagram|flowchart|graph|gantt|zenuml|mindmap|pie)\b/i.exec(body);
  if (existing) return body.replace(existing[1], existing[1].toLowerCase() === "zenuml" ? "zenuml" : existing[1]);
  return header + (["flow", "flowchart"].includes(language) ? " TD" : "") + "\n" + body;
}
