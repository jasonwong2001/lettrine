// Settings fields generated from one table: [group, key, label, type, default,
// options]. Each group is a `data-pref-group` section in index.html; select
// options are [value, label] pairs.
import { parseUploadConfig } from "../core/images.js";
import { sanitizeCodeLanguage } from "../core/code-tools.js";
import { MARKDOWN_EXTENSIONS } from "../core/documents.js";

const FIELDS = [
  ["general-saving", "autosaveSec", "Save after a pause of (seconds)", "number", 2, [1, 3600]],
  ["general-saving", "askToCloseUnsaved", "Ask before closing or replacing unsaved documents", "checkbox", true],
  ["general-saving", "saveOnSwitch", "Save existing documents when switching away", "checkbox", false],
  ["general-files", "defaultExtension", "Default extension for new files", "select", "md", [...MARKDOWN_EXTENSIONS, "txt", "text"].map((extension) => [extension, "." + extension])],
  ["general-files", "showHiddenFiles", "Show hidden files in the library", "checkbox", false],
  ["general-files", "pinnedFolders", "Pinned folders (one absolute path per line)", "lines", []],
  ["general-startup", "openRecentOnStart", "Reopen the most recent file at startup", "checkbox", false],
  ["general-startup", "restoreSession", "Restore windows, tabs and unsaved drafts at startup", "checkbox", false],
  ["general-startup", "quitAfterLastWindow", "Quit after closing the last window", "checkbox", false],
  ["general-startup", "otherEditor", "Application for other file types", "text", ""],
  ["general-maintenance", "checkUpdatesAutomatically", "Check for updates automatically", "checkbox", false],
  ["general-maintenance", "anonymousUsageReports", "Send anonymous usage reports", "checkbox", false],
  ["general-import", "editorFileDrop", "Document files dropped into the editor", "select", "link", [["link", "Insert a file link"], ["import", "Import as Markdown"]]],
  ["general-import", "sidebarFileDrop", "Document files dropped into the sidebar", "select", "import", [["import", "Import as Markdown"], ["ignore", "Ignore file drops"]]],
  ["editor-writing", "autoPair", "Automatically pair brackets and quotes", "checkbox", true],
  ["editor-writing", "autoPairMarkdown", "Automatically complete Markdown markers", "checkbox", false],
  ["editor-writing", "autoExpandSimple", "Show empty heading and quote markers on focus", "checkbox", true],
  ["editor-writing", "smartList", "Continue lists on Enter", "checkbox", true],
  ["editor-writing", "preserveBreaks", "Preserve single line breaks", "checkbox", true],
  ["editor-writing", "hideBreakMarkers", "Hide HTML line break markers", "checkbox", false],
  ["editor-writing", "ignoreHeadingBreaks", "Ignore line breaks inside headings", "checkbox", false],
  ["editor-typography", "smartQuotes", "Smart quotes", "checkbox", false],
  ["editor-typography", "smartDashes", "Smart dashes", "checkbox", false],
  ["editor-typography", "smartEllipses", "Smart ellipses", "checkbox", false],
  ["editor-typography", "smartPunctuationMode", "Apply smart punctuation", "select", "render", [["render", "Convert on rendering"], ["input", "Convert on input"]]],
  ["editor-indent", "tabSize", "Tab size", "number", 4, [1, 16]],
  ["editor-indent", "indentWithTabs", "Indent with tabs instead of spaces", "checkbox", false],
  ["editor-code", "codeIndentSize", "Code indent size", "number", 4, [1, 16]],
  ["editor-code", "codeShiftTab", "Shift+Tab in code", "select", "outdent", [["outdent", "Outdent selected code"], ["auto", "Auto indent selected code"]]],
  ["editor-code", "defaultCodeLanguage", "Default code language", "text", ""],
  ["editor-code", "wrapCode", "Wrap long lines in code fences", "checkbox", true],
  ["editor-render", "renderMath", "Render math formulas", "checkbox", true],
  ["editor-render", "numberEquations", "Number display equations", "checkbox", true],
  ["editor-render", "subscriptSuperscript", "Enable subscript and superscript", "checkbox", false],
  ["editor-render", "renderDiagrams", "Render Mermaid diagrams", "checkbox", true],
  ["editor-render", "fenceEditor", "Edit code blocks with syntax highlighting", "checkbox", true],
  ["editor-modes", "sourceByDefault", "Open documents in Source Code Mode", "checkbox", false],
  ["appearance-mode", "background", "Appearance", "select", "system", [["system", "Match System"], ["light", "Light"], ["dark", "Dark"]]],
  ["appearance-text", "fontFamily", "Font", "text", ""],
  ["appearance-text", "lineHeight", "Line height", "number", 1.6, [1, 3, 0.1]],
  ["appearance-text", "pageWidth", "Page width", "select", "medium", [["narrow", "Narrow"], ["medium", "Medium"], ["wide", "Wide"]]],
  ["appearance-text", "indentFirstLine", "Indent the first line of paragraphs", "checkbox", false],
  ["appearance-window", "sidebarVisible", "Show the sidebar in new windows", "checkbox", true],
  ["appearance-window", "showDocumentToolbar", "Show the document toolbar", "checkbox", false],
  ["appearance-window", "zoomByMouse", "Zoom with Command or Control + scroll", "checkbox", false],
  ["appearance-window", "pinWindows", "Keep windows on top", "checkbox", false],
  ["image-upload", "imageUploadOnPaste", "Upload pasted images automatically", "checkbox", false],
  ["image-upload", "imageUploader", "Image uploader", "select", "command", [["command", "Custom command"], ["http", "HTTP upload"], ["picgo", "PicGo"], ["upic", "uPic"]]],
  ["image-upload", "imageUploadConfig", "Upload configuration (YAML or JSON)", "textarea", ""],
  ["export-pdf", "pdfPageSize", "Page size", "select", "A4", ["A4", "A3", "A5", "Letter", "Legal", "Tabloid"].map((size) => [size, size])],
  ["export-pdf", "pdfMargin", "Margins (inches)", "number", 0.75, [0, 3, 0.05]],
  ["export-pdf", "pdfHeaderFooter", "Include the header and footer", "checkbox", true],
  ["export-pandoc", "pandocPath", "Pandoc executable", "text", ""],
  ["export-image", "imageExportFormat", "Image format", "select", "png", [["png", "PNG"], ["jpg", "JPEG"]]],
  ["export-image", "imageExportScale", "Image scale", "select", "2", [["1", "1×"], ["2", "2×"], ["3", "3×"]]],
  ["export-destination", "exportFolder", "Default export folder", "text", ""],
  ["export-after", "revealAfterExport", "Show the export in Finder", "checkbox", false],
];
const PLACEHOLDERS = { fontFamily: "Theme default", otherEditor: "System default", pandocPath: "Found on PATH", exportFolder: "Remember the last export folder", imageUploadConfig: "command: /path/to/uploader {file}", defaultCodeLanguage: "Reuse the previous code language" };
const field = (key) => document.getElementById("pref-extra-" + key);
export function initExtraPreferences() {
  for (const [group, key, label, type, , options] of FIELDS) {
    const host = document.querySelector(`#preferences-dialog [data-pref-group="${group}"]`);
    const wrapper = document.createElement("label"); wrapper.className = type === "checkbox" ? "pref-row pref-check" : "pref-row";
    const input = document.createElement(type === "select" ? "select" : ["textarea", "lines"].includes(type) ? "textarea" : "input"); input.id = "pref-extra-" + key;
    if (!["select", "textarea", "lines"].includes(type)) input.type = type;
    if (type === "select") for (const [value, text] of options) { const option = document.createElement("option"); option.value = value; option.textContent = text; input.appendChild(option); }
    if (["textarea", "lines"].includes(type)) { input.rows = type === "lines" ? 3 : 6; input.spellcheck = false; wrapper.className = "pref-field"; }
    if (type === "number") { input.min = options[0]; input.max = options[1]; input.step = options[2] || 1; }
    if (PLACEHOLDERS[key]) input.placeholder = PLACEHOLDERS[key];
    if (type === "text") { input.spellcheck = false; input.autocomplete = "off"; }
    const text = document.createElement("span"); text.textContent = label;
    if (type !== "checkbox") text.className = "pref-label";
    if (type === "checkbox") wrapper.append(input, text); else wrapper.append(text, input);
    host.appendChild(wrapper);
  }
  const replacements = document.createElement("label"); replacements.className = "pref-field";
  replacements.append("Abbreviations expanded as you type, as JSON: {\"(c)\": \"©\"}");
  const textarea = document.createElement("textarea"); textarea.id = "pref-text-replacements"; textarea.rows = 5; textarea.spellcheck = false;
  replacements.appendChild(textarea);
  const group = document.querySelector('#preferences-dialog [data-pref-group="editor-replacements"]');
  group.classList.add("pref-stack");
  group.appendChild(replacements);
}
export function loadExtraPreferences(settings) {
  for (const [, key, , type, fallback] of FIELDS) field(key)[type === "checkbox" ? "checked" : "value"] = type === "lines" ? (Array.isArray(settings[key]) ? settings[key] : fallback).join("\n") : settings[key] ?? fallback;
  document.getElementById("pref-text-replacements").value = JSON.stringify(settings.textReplacements || {}, null, 2);
  const services = window.__lettrine?.maintenance || {};
  // A release without update or usage services only points to its releases page.
  const releasesOnly = !services.updates && !services.reporting && !!services.releasesURL;
  field("checkUpdatesAutomatically").disabled = !services.updates;
  field("anonymousUsageReports").disabled = !services.reporting;
  document.querySelector('#preferences-dialog [data-pref-group="general-maintenance"]').hidden = releasesOnly;
  document.getElementById("pref-maintenance-reports").hidden = releasesOnly;
  document.getElementById("pref-check-updates").disabled = !services.updates && !services.releasesURL;
  document.getElementById("pref-privacy").disabled = !services.privacyURL;
  document.getElementById("pref-privacy").hidden = releasesOnly;
  document.getElementById("pref-maintenance-unavailable").hidden = releasesOnly || !!services.updates && !!services.reporting;
  document.getElementById("pref-maintenance-releases").hidden = !releasesOnly;
}
export function extraPreferencesPatch() {
  const patch = {};
  for (const [, key, , type, fallback, limits] of FIELDS) {
    const number = Number(field(key).value);
    patch[key] = type === "checkbox" ? field(key).checked : type === "number" ? Math.max(limits[0], Math.min(limits[1], Number.isFinite(number) && field(key).value !== "" ? number : fallback)) : type === "lines" ? [...new Set(field(key).value.split("\n").map((line) => line.trim()).filter(Boolean))] : field(key).value.trim();
  }
  if (patch.pinnedFolders.some((folder) => !/^(?:\/|~\/)/.test(folder))) throw Error("Pinned folders must use absolute paths or start with ~/.");
  let replacements;
  try { replacements = JSON.parse(document.getElementById("pref-text-replacements").value || "{}"); }
  catch { throw Error("Text replacements must be a JSON object, for example {\"(c)\": \"©\"}."); }
  if (!replacements || Array.isArray(replacements) || typeof replacements !== "object" || Object.values(replacements).some((value) => typeof value !== "string")) throw Error("Each text replacement must map an abbreviation to text.");
  patch.textReplacements = replacements;
  patch.defaultCodeLanguage = sanitizeCodeLanguage(patch.defaultCodeLanguage);
  patch.imageUploadOptions = parseUploadConfig(patch.imageUploadConfig);
  if (patch.imageUploadOnPaste) {
    if (patch.imageUploader === "command" && !patch.imageUploadOptions.command?.includes("{file}")) throw Error("The upload command must contain {file}.");
    if (patch.imageUploader === "http" && !/^https?:\/\//i.test(patch.imageUploadOptions.url || "")) throw Error("Enter an HTTP or HTTPS upload URL.");
  }
  return patch;
}
