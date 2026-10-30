export function linkMarkdown(label, url, title = "") {
  const text = String(label ?? url).replace(/\r?\n/g, " ").replace(/([\\\[\]])/g, "\\$1");
  const destination = /\s/.test(url) ? "<" + url.replace(/>/g, "%3E") + ">" : url.replace(/([\\()])/g, "\\$1");
  const suffix = title ? ' "' + title.replace(/([\\"])/g, "\\$1").replace(/\r?\n/g, " ") + '"' : "";
  return { source: `[${text}](${destination}${suffix})`, labelLength: text.length };
}

export function headingSlug(text) {
  return String(text).trim().toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, "").replace(/\s+/g, "-");
}
