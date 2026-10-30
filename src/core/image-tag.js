const decode = (value) => value.replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt);/gi, (source, entity) => {
  const named = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
  if (entity[0] !== "#") return named[entity.toLowerCase()] || source;
  const code = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : source;
});
export const imageAttribute = (value) => String(value).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Only image data is read; arbitrary HTML attributes never reach the rendered DOM.
export function parseImageTag(source, offset = 0) {
  const tag = /^<img\b(?:[^"'<>]|"[^"]*"|'[^']*')*>/i.exec(source.slice(offset))?.[0];
  if (!tag) return null;
  const attributes = {};
  const pattern = /([-\w:]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g;
  let urlStart, urlEnd;
  for (const match of tag.matchAll(pattern)) {
    const name = match[1].toLowerCase(), value = match[2] ?? match[3] ?? match[4];
    if (Object.hasOwn(attributes, name)) continue;
    attributes[name] = decode(value);
    if (name === "src") {
      urlStart = match.index + match[0].indexOf("=") + 1;
      while (/\s/.test(tag[urlStart])) urlStart++;
      if (tag[urlStart] === '"' || tag[urlStart] === "'") urlStart++;
      urlEnd = urlStart + value.length;
    }
  }
  if (!attributes.src) return null;
  const size = (name) => /^\d+(?:\.\d+)?$/.test(attributes[name] || "") && Number(attributes[name]) > 0 ? Number(attributes[name]) : null;
  const zoom = /(?:^|;)\s*zoom\s*:\s*(\d+(?:\.\d+)?)\s*%/i.exec(attributes.style || "");
  return { type: "image", syntax: "html", src: tag, url: attributes.src, alt: attributes.alt || "", title: attributes.title || null,
    width: size("width"), height: size("height"), zoom: zoom ? Math.max(25, Math.min(200, Number(zoom[1]))) : 100,
    urlStart, urlEnd, urlEncoding: "html" };
}

export function imageHTML(image, zoom = image.zoom || 100) {
  return `<img src="${imageAttribute(image.url)}" alt="${imageAttribute(image.alt || "")}"` +
    (image.title ? ` title="${imageAttribute(image.title)}"` : "") +
    (image.width ? ` width="${image.width}"` : "") + (image.height ? ` height="${image.height}"` : "") +
    (zoom !== 100 ? ` style="zoom:${zoom}%;"` : "") + ">";
}
