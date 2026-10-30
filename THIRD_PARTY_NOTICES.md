# Third-party notices

The Lettrine app includes the following open-source software. Each package's license file is copied into the app bundle under `Contents/Resources/web/node_modules/<package>/`. Additional font and bundled dependency licenses are in `Contents/Resources/web/licenses/`.

| Component | Used for | License |
|---|---|---|
| [CodeMirror 5](https://codemirror.net/5/) | code, math and Source Code Mode editors | MIT. Copyright Marijn Haverbeke and others. |
| [KaTeX](https://katex.org) | typesetting math | MIT. Copyright Khan Academy and other contributors. Font attributions, reserved font names and the complete SIL Open Font License 1.1 are in `licenses/katex-fonts.txt`. |
| [Mermaid](https://mermaid.js.org) | diagrams | MIT. Copyright Knut Sveidqvist. The licenses for its bundled dependencies, including DOMPurify under the Apache License 2.0 option, D3, Lodash, Cytoscape and Rough.js, are in `licenses/mermaid.txt`. |
| [Mermaid ZenUML](https://github.com/mermaid-js/mermaid-zenuml) | ZenUML sequence diagrams | MIT. Includes ZenUML Core and its bundled dependencies; their matching release license texts and icon attribution are in `licenses/zenuml.txt`. |
| [markdown-it](https://github.com/markdown-it/markdown-it) | HTML and PDF export | MIT. Copyright Vitaly Puzrin and Alex Kocharin. Its bundled parser and URL helper licenses are in `licenses/markdown-it.txt`. |
| [gemoji](https://github.com/wooorm/gemoji) | emoji names and keywords, generated into `src/core/vendor` | MIT. Copyright Titus Wormer. |

Lettrine also uses AppKit, WebKit and PDFKit, which are part of macOS. Pandoc, which some exports use, is installed separately and isn't included.
