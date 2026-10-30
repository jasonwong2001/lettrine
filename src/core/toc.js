export function tocOptions(pattern = "") {
  const depth = /\b(?:depth|max-level)\s*=\s*["']?([1-6])(?:["'\s}]|$)/i.exec(pattern);
  const width = /\bwidth\s*=\s*["']?(\d+(?:px|%))["']?(?=\s|}|$)/i.exec(pattern)?.[1];
  let safeWidth;
  if (width?.endsWith("%") && parseInt(width, 10) >= 1 && parseInt(width, 10) <= 100) safeWidth = width;
  if (width?.endsWith("px") && parseInt(width, 10) >= 80 && parseInt(width, 10) <= 2000) safeWidth = width;
  return { depth: depth ? Number(depth[1]) : 6, width: safeWidth };
}
