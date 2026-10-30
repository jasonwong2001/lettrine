export const IMPORT_FORMATS = {
  docx: "docx", html: "html", htm: "html", rst: "rst", rest: "rst",
  tex: "latex", latex: "latex", org: "org", opml: "opml",
  textile: "textile", wiki: "mediawiki", mediawiki: "mediawiki", mdx: "gfm",
};
export const importFormat = (file) => IMPORT_FORMATS[/\.([^.\/]+)$/.exec(String(file))?.[1].toLowerCase()] || null;
export function importDefaultPath(file, folder) {
  const name = String(file).split("/").at(-1).replace(/\.[^.]+$/, "") || "Imported";
  return (folder ? folder.replace(/\/+$/, "") + "/" : String(file).slice(0, String(file).lastIndexOf("/") + 1)) + name + ".md";
}
