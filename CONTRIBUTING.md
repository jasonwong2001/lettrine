# Contributing to Lettrine

Thanks for helping. This guide covers building the app, running the tests, and the few rules that keep the editor correct and fast.

Use [issues](https://github.com/jason-bot-147/lettrine/issues) for bug reports and focused feature proposals, and pull requests for changes. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md), and report vulnerabilities privately as the [security policy](SECURITY.md) describes.

## Setup

You need macOS 13 or later, the Xcode Command Line Tools (tested with Swift 6.2) and Node.js 22 or later.

```sh
npm install
npm start          # build dist/development/Lettrine.app and open it
npm run dist:dir   # build without opening
npm run dist       # build, then zip the app into dist/
```

The build compiles `native/Sources` with `swiftc`, copies the page and the parts of its dependencies it uses into the app bundle, and signs the bundle for the local Mac. There is no Xcode project.

`npm run release:snapshot` builds a release from a clean checkout instead: the host is compiled for Apple silicon and Intel and signed with the hardened runtime.

## Releases

Release packaging requires a clean Git checkout and a GitHub `origin` remote, or `LETTRINE_RELEASES_URL` set to the HTTPS releases page. `npm run release:snapshot` writes `dist/Lettrine-<version>-snapshot-<commit>.zip` and `dist/SHA256SUMS` for review.

For a release, set the version in `package.json` and `package-lock.json` with `npm version <version> --no-git-tag-version`, date its section in `CHANGELOG.md`, and commit the changes. Tag that commit `v<version>`. `npm run release` then creates `dist/Lettrine-<version>.zip` and its checksum. Pushing the tag runs the release workflow, which builds the app and creates a draft GitHub release with both files attached.

Before publishing the draft, verify the downloaded zip with `shasum -a 256 -c SHA256SUMS`, unzip it, and run `codesign --verify --strict Lettrine.app`. Check the app on Apple silicon and Intel, or under Rosetta. Releases are ad-hoc signed with the hardened runtime and aren't notarized; the [README](README.md#install) explains first-launch approval.

## Project layout

```
native/Sources/    Swift host: windows, menus, files, export and the bridge
native/Resources/  app icon drawings and the generated AppIcon.icns
src/core/          the Markdown model: parsing and editing operations, no DOM
src/renderer/      the page: editor, interface, styles and themes
src/locales/       interface translations
scripts/           build, packaging, icon and emoji generation
test/              unit and DOM tests (*.test.mjs) and native app scenarios
examples/          a document that tours the features
docs/images/       screenshots used by the README
licenses/          font and bundled dependency license texts
.github/           CI workflow, issue and pull request templates
```

## Tests

`npm test` runs the unit and DOM tests in Node with jsdom, in about half a minute. They cover the Markdown model, rendering and reading the page back as Markdown, editing commands, undo, and the interface wiring with a stand-in for the native host.

The native suites drive the real app. The default group covers native input, editing, selection, files and workspace behavior. Build first, then run the relevant individual suite or the editing group:

```sh
npm run dist:dir
npm run test:native
```

They take several minutes and use the keyboard, the mouse and window focus, so leave the Mac alone while they run and don't run two at once. Each suite prints a folder with its report, screenshots and log. To run a single suite, use `npm run test:editor`, `test:headings`, `test:features`, `test:selection` or `test:workspace`, or run any scenario file directly, such as `node test/typography.mjs`; add the path of another `Lettrine.app` to test that build instead. Editing and selection changes normally need only their relevant suites. The heading scenario checks the caret and marker during native input and its first frame, plus continued typing and undo with marker completion enabled and disabled.

`npm run test:library` creates an isolated library with more than 5,000 documents and 650 directories, and runs the app with a 256-descriptor limit to catch directory-watch exhaustion. It checks bounded sidebar rendering, native keyboard navigation, search results and cancellation, Close Search, closing pending folder loads, file deletion and external deletion. It does not export files or open external applications.

`npm run test:exports` explicitly runs export coverage, including the source-view export checks moved out of `test:editor`. `npm run test:native:all` runs the complete native suite, including exports and the broader feature scenarios. Do not run either automatically for an unrelated editor change. Use `npm run test:native -- --list` (optionally with `--all` or `--exports`) to inspect a group without launching anything.

Harness mode intercepts external application opens, browser links, image previews, Finder reveals and system-settings links. Requests are recorded in `external-actions.json` in each report folder; exported files are still produced and inspected directly. This works independently of the profile's “Open the exported file” and “Show the export in Finder” settings. `npm run test:external-actions` verifies this isolation, including export with both settings enabled. Actual external-app integration requires an explicitly requested manual check; the native executable accepts `--lettrine-allow-external-apps` with `--lettrine-harness` for that purpose. Keep that flag out of routine test commands.

The scenarios below run with `test:exports` or `test:native:all`, or on their own. Some need Pandoc or Poppler; Homebrew installs both with `brew install pandoc poppler`.

- `editor-exports.mjs` (the source-view export checks) and `export-surface.mjs` need Pandoc installed. `export-surface.mjs` converts the tour document to every supported target and checks the resulting files, alongside the built-in PDF and image exports.
- `typography.mjs` uses Pandoc and Poppler's `pdftotext` to verify exported punctuation.
- `equations.mjs` uses the same tools to check numbering and references in HTML, PDF and Word exports.
- `scripts.mjs` requires Pandoc and inspects Word formatting for both enabled and disabled subscript/superscript settings.
- `imports.mjs` also requires Pandoc. It converts every supported input format, checks extracted Word images, and exercises failure recovery and file-drop policies.
- `image-management.mjs` uses Pandoc for Word image output and runs isolated uploader executables plus a local HTTP server. It covers file/text undo, shared and batch image moves, source mode, upload failures and file-queue responsiveness without using an external upload account.
- `code-tools.mjs` covers whitespace-only formatting, whole/selected indentation, native keyboard undo and redo, code tab settings, default languages, fence-marker completion, Source Code Mode, readonly guards, localization and themes.
- `clipboard-selection.mjs` reads the real macOS pasteboard after special-copy menu commands and checks exact TeX, MathML, code and pipe-table data, clean HTML with portable images, structural selections and deletions, independent undo/redo, Source Code Mode, readonly, themes and localized menus.
- `diagrams.mjs` covers offline ZenUML and math fences, common Mermaid dialects and fence aliases, live native editing and undo, static SVG HTML, PDF, clipboard PNGs, light/dark themes, readonly, settings, localized errors and renderer/syntax failure recovery. It also uses Poppler's `pdftotext` and `pdftoppm` for PDF verification.
- `settings-breadth.mjs` checks persistent editor and file-format options, real native typing, the native Save As line-ending control, final-newline undo, hidden-file indexing, save on document/window switches, readonly, localization, actual restart and quit after the last window closes. The scenario supplies an isolated default destination; the harness checks that native panel destination, selects its line-ending control and ends its sheet through AppKit. Its timer also runs in modal modes.
- `sidebar-views.mjs` covers the Files and Outline tabs, tree and list views, native keyboard and pointer navigation, live retained outline rows, preview/source/readonly heading jumps, on-demand folder search, independent window choices, localized labels and light/dark layouts.
- `outline-navigation.mjs` checks the sidebar outline and the outline toggle that puts the sidebar back as it was, current-section tracking, native keyboard heading jumps, Source Code Mode, readonly, localized empty states, light/dark layouts and the remembered view after an actual restart.
- `document-toolbar.mjs` uses native pointer clicks and keyboard input to exercise formatting selections, the heading menu, lists, tables, math, code, link/image insertion and TOC. It checks source typing/formatting/table undo, readonly controls, translations, themes and toolbar visibility across windows and restarts.
- `zoom-ux.mjs` exercises the zoom popover and the title-bar percentage shown while zoomed in WKWebView, native preview/code/source typing and undo at different zooms, retained DOM and mounted editors, stable chrome and sidebar geometry, bounds and concurrent native increments, opt-in modifier scrolling, readonly, translations, themes, cross-window sync and an actual restart. It activates popover buttons through DOM events; desktop pointer acceptance belongs to a visible, unlocked macOS session.
- `app-behavior.mjs` covers actual quit/relaunch with native window/tab groups, dirty and untitled drafts, source selections, readonly, new typing/undo, Save All and native Save As cancellation/completion. It also checks changed/missing files, current disk line endings, recent-file and explicit-file startup precedence, opt-out deletion, oversized-draft recovery and failed checkpoints. Set `LETTRINE_TEST_TRACE=1` for live native progress in its report folder.
- `maintenance.mjs` uses an HTTP server on `127.0.0.1` for appcasts and reports. It checks secure build configuration, default-off consent, exact minimal payloads, opt-out, restart/daily limits, numeric version and OS/channel filtering, manual/automatic notifications, failure bounds, locales and themes. The loopback override is accepted only in harness mode; no production service or external telemetry account is used. It also checks that a release without these services opens its releases page from Check for Updates without contacting it.
Native scenarios must run sequentially. Do not rebuild the app bundle while a scenario is running. The harness tracks the selected native document explicitly and waits for its renderer and requested file to finish opening; this avoids testing the previous window when macOS has no key window. Trace output records AppKit's active/key-window state. Pointer scenarios and the window-switch save-on-resign test still require a visible, unlocked desktop; native text input or DOM click checks do not establish those results.

Please run `npm test` before opening a pull request, plus the relevant native scenarios when you change editing, files or the interface. Reserve the complete suite for release checks, broad changes or an explicit request.

CI runs `npm test` and builds a release snapshot for every pull request and every push to `main`. It can't run the native scenarios, which need an interactive desktop, so run the relevant ones yourself and say which in the pull request.

`npm run test:performance` measures native editing and rendering performance with isolated documents and profiles.

## Keeping the editor correct

Lettrine's central promise is that the document on screen turns back into exactly the Markdown that was loaded, plus the user's edits. To preserve this:

- Everything the user typed stays in the DOM. Complete syntax markers go in a hidden `span.md-attr`, unfinished ones in a visible `span.md-tag`.
- Anything the editor adds only for display, such as footnote numbers, table controls or rendered math, has the `md-decor` class so it is left out when the page is read back as Markdown.
- New syntax comes with a test that it round-trips: Markdown → blocks → DOM → Markdown gives back the same text.
- Code that edits a block's DOM in place, as the task checkbox does, sets `node.__block` to the block the element now shows.
- Privileged work (files, dialogs, system services) belongs in the Swift host behind a bridge method; declare it in `src/renderer/native-bridge.js` and handle its channel in `native/Sources`.

## Keeping it fast

- Don't add `:empty`, `:nth-child`, `:nth-of-type` or `~` selectors that match `#write` or its children. WebKit then restyles every block whenever one is inserted.
- Don't put `contain` or `content-visibility` on blocks; in WebKit they make editing 10 to 20 times slower.
- Edits re-render only the blocks that changed. Only a change to rendering settings calls `editor.renderAll({ full: true })`.

## Interface conventions

- Controls are styled in `src/renderer/styles/chrome.css` with ID or `ui-` class selectors, so a theme can't restyle them by accident. Themes style only the document.
- Icons are `<symbol>`s in the sprite at the top of `src/renderer/index.html`, drawn on a 16 px grid with a 1.5 px stroke.
- Prefer native menus (`showMenu` in `ui.js`) to menus drawn in the page.
- In the title bars, only buttons, links and form controls receive clicks; the rest of the bar moves the window. Never reposition the window buttons; the page follows the geometry the host reports.

## Text and translations

Interface text is written in English in the code. Add each new string to `src/locales/en.json`, where the key and the value are both the English text, and add its translations to `zh-Hans.json` and `zh-Hant.json`. A string without a translation shows in English.

To add a language, copy `en.json` to `<locale>.json` (for example `ja.json`), translate the values, and add the language's name, written in that language, to `languageNames` in `scripts/build-native.mjs`.

## Generated files

- `native/Resources/AppIcon.icns` comes from the two icon drawings next to it. Run `node scripts/make-icon.mjs` after changing them; it needs `rsvg-convert` (`brew install librsvg`).
- `src/core/vendor/emoji-data.js` and `emoji-search.js` come from the `gemoji` package. Run `node scripts/make-emoji.mjs` after updating it.
- `licenses/mermaid.txt`, `licenses/zenuml.txt` and `licenses/markdown-it.txt` record bundled dependency versions and their upstream license texts. Identify components from each bundle's source map and use matching release licenses, including embedded Rough.js helpers. Refresh these files when updating the libraries; the build checks their bundle SHA-256. `licenses/katex-fonts.txt` contains the font metadata attributions and the complete SIL Open Font License.

## Pull requests

Keep each pull request to one change, and describe the problem and what changes for someone using Lettrine. When behavior changes, update any affected README instructions and add a line to the [changelog](CHANGELOG.md). The pull request template lists the checks to run.
