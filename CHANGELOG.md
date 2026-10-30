# Changelog

All notable changes to Lettrine are documented here, following [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The first public release.

### Added

- Markdown that renders as you type: headings, emphasis, underline, links, images, lists and task lists, quotes, GitHub-style alerts, tables, footnotes and a table of contents. The file keeps exactly the Markdown you wrote.
- Math typeset with KaTeX, with numbered display equations you can refer to; Mermaid and ZenUML diagrams; and syntax-colored code with an editor for each language.
- Source Code Mode (⌘/) and Readonly Mode (⌥⌘R).
- A sidebar with your folder as a tree or a list, or the document's outline, plus folder search (⇧⌘F) and Quick Open (⇧⌘O). Rename, move, duplicate and trash files with undo.
- Atomic saves, optional autosave, document history, and optionally restoring your windows and unsaved drafts.
- Export to HTML, PDF and PNG/JPEG images, and through Pandoc to Word, EPUB, RTF, OpenDocument, LaTeX and more. Import Word, HTML, LaTeX and other formats through Pandoc.
- Copy as Image, image file management and optional image uploads.
- Optional smart punctuation, and subscript and superscript.
- Light and dark themes, custom CSS themes, document zoom, an optional document toolbar, and focus and typewriter modes.
- English, Simplified Chinese and Traditional Chinese.
- One app for Apple silicon and Intel Macs on macOS 13 or later. It's ad-hoc signed and not notarized; the README explains how to open it the first time. It doesn't check for updates: Check for Updates… opens the releases page.

### Fixed

- Deleting an empty formula returns the caret to a paragraph without leaving the extra blank lines from formula completion. Undo restores the formula and its caret.
