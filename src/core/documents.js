export const MARKDOWN_EXTENSIONS = ["md", "markdown", "mdown", "mkdn", "mmd", "mkd", "mdwn", "mdtxt", "mdtext", "rmarkdown", "rmd", "apib", "qmd", "mdx"];

const markdownExtensions = new Set(MARKDOWN_EXTENSIONS);
export function isMarkdownExtension(extension) {
  return markdownExtensions.has(extension.replace(/^\./, "").toLowerCase());
}
