export const EXPORT_EXTENSIONS = { latex: "tex", docbook: "db", mediawiki: "wiki", image: "png" };
const RENDER_SETTINGS = ["fontSize", "fontFamily", "lineHeight", "pageWidth", "preserveBreaks", "renderMath", "numberEquations", "subscriptSuperscript", "renderDiagrams", "smartQuotes", "smartDashes", "smartEllipses", "smartPunctuationMode"];

export function exportOptions(format, settings, theme, dark, overrides = {}) {
  const options = {
    theme, dark,
    settings: Object.fromEntries(RENDER_SETTINGS.filter((key) => settings[key] !== undefined).map((key) => [key, settings[key]])),
  };
  if (format === "pdf") Object.assign(options, {
    pdfHeader: settings.pdfHeader || "", pdfFooter: settings.pdfFooter ?? "", author: settings.pdfAuthor || "",
    pageSize: settings.pdfPageSize || "A4", displayHeaderFooter: settings.pdfHeaderFooter !== false,
    ...Object.fromEntries(["Top", "Bottom", "Left", "Right"].map((edge) => ["margin" + edge, settings.pdfMargin ?? 0.75])),
  });
  if (["png", "jpg", "jpeg", "image"].includes(format)) Object.assign(options, {
    format: format === "image" ? settings.imageExportFormat || "png" : format,
    scale: Number(settings.imageExportScale) || 2,
  });
  if (!["md", "html", "pdf", "png", "jpg", "jpeg", "image"].includes(format)) options.pandocPath = settings.pandocPath;
  return { ...options, ...overrides };
}

export function exportDestination(file, extension, settings) {
  const base = file ? file.replace(/\.[^/.]+$/, "") : "/tmp/lettrine-export";
  const folder = settings.exportFolder || settings.lastExportFolder;
  return `${folder ? folder.replace(/\/+$/, "") + "/" + base.split("/").pop() : base}.${extension}`;
}
