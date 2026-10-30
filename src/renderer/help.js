const guides = {
  themes: ["Custom Themes", "<p>Open the theme folder from Settings → Appearance. Add a CSS file such as <code>my-theme.css</code>, then select it in the theme picker.</p><p>Use <code>base.user.css</code> for overrides shared by all themes, or <code>my-theme.user.css</code> for one theme. Style <code>#write</code> for the document and use <code>--bg-color</code> and <code>--text-color</code> for page colors. Returning to the app reloads changed styles.</p>"],
  welcome: ["Welcome to Lettrine", `<p>Write Markdown directly in the document. Finished syntax becomes formatted text; unfinished syntax remains visible.</p>
    <h3>Writing</h3><p>Use ⌘B for bold, ⌘I for italic, ⌘E for inline code and ⌘K to edit links. ⌘/ switches to Source Code Mode. ⌘F finds text in the document and ⌥⌘F replaces it.</p>
    <p>For a formula, type <code>$$</code>, press Enter, enter TeX, press Enter, then type <code>$$</code>. ⌘Enter also finishes a formula or code block. Click its preview to edit it again.</p>
    <h3>Files and recovery</h3><p>Open a folder from the sidebar to browse and search its files. ⇧⌘O jumps to any file by name and ⇧⌘F searches the text of every file in the folder. Click the document title for its location, word count and history. File → Document History restores earlier versions, and file operations have their own undo in the Edit menu.</p>
    <h3>Make it yours</h3><p>Settings (⌘,) controls fonts, themes, writing modes, spelling, image storage and keyboard shortcuts. Help → Keyboard Shortcuts shows and edits every shortcut.</p>`],
  markdown: ["Markdown Reference", `<p>Common constructs supported by the live editor:</p>
    <pre># Heading\n\n**bold**, *italic*, ~~strikethrough~~, ==highlight==, &#96;code&#96;\n\n[link](https://example.com)\n![image](assets/image.png)\n\n- List item\n  - Nested item\n- [ ] Task\n- [x] Completed task\n\n&gt; A quotation\n\n| Left | Right |\n| :--- | ---: |\n| A | B |\n\n&#96;&#96;&#96;javascript\nconst answer = 42;\n&#96;&#96;&#96;\n\n$$\nx^2 + y^2 = z^2\n$$\n\nA reference[^note].\n\n[^note]: Footnote text.\n\n[toc]</pre>
    <p>Use a <code>mermaid</code> code fence for diagrams. Type <code>:smile</code> for emoji completion, use arrows to choose, then Escape to insert. Cmd/Ctrl-click follows a link; an ordinary click keeps editing.</p>`],
  pandoc: ["Install and Use Pandoc", `<p>Markdown, HTML, PDF and Screenshot as HTML are built in. Word (DOCX), EPUB, RTF, ODT and LaTeX exports use your own Pandoc installation.</p>
    <ol><li>Install Pandoc for your operating system from <a href="https://pandoc.org/installing.html">the official installation guide</a>.</li><li>Open Settings → Export and set the Pandoc executable path if it is not available on PATH.</li><li>Choose File → Export and the output format, then choose a destination.</li></ol>
    <p>HTML embeds local images, fonts, theme CSS, math and diagram support. PDF uses a separate print view; its page size, margins, header, footer and author are set in Settings → Export.</p>`],
  license: ["License", "<p>Lettrine is free, open-source software released under the MIT License.</p><p>It is built with AppKit and the system's WebKit, and includes CodeMirror, KaTeX, Mermaid, markdown-it and GitHub's emoji names (gemoji). PDF export uses PDFKit. The app bundle contains the license of each of these components.</p>"],
  feedback: ["Feedback", "<p>Report problems and ideas on the project's GitHub page. Include your Lettrine version (Lettrine › About Lettrine), your macOS version, the steps that lead to the problem and, if you can, a small Markdown file that shows it.</p><p>For a rendering or editing problem, Source Code Mode (⌘/) shows the Markdown Lettrine has saved, which helps tell a display problem from a change to the file.</p>"],
};

export function showHelp(app, topic = "welcome") {
  const [title, html] = guides[topic] || guides.welcome;
  const previousFocus = document.activeElement, selection = app.editor.selectionOffsets();
  const modal = document.createElement("div"); modal.className = "modal open help-dialog";
  modal.setAttribute("role", "dialog"); modal.setAttribute("aria-modal", "true"); modal.setAttribute("aria-label", title);
  modal.innerHTML = '<div class="modal-dialog"><div class="modal-content"><div class="modal-header"><h2 class="modal-title"></h2></div><article class="modal-body"></article><div class="modal-footer"><button type="button" class="ui-btn ui-btn-primary">Done</button></div></div></div>';
  modal.querySelector(".modal-title").textContent = title; modal.querySelector("article").innerHTML = html;
  const close = () => {
    modal.remove(); document.removeEventListener("keydown", onKey);
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    else { app.editor.root.focus({ preventScroll: true }); if (selection) app.editor.selectOffsets(selection.start, selection.end, selection.backward); }
  };
  const onKey = (event) => { if (event.key === "Escape") { event.preventDefault(); close(); } };
  modal.querySelector("button").onclick = close;
  modal.querySelectorAll("a").forEach((link) => link.addEventListener("click", (event) => { event.preventDefault(); void window.bridge.shell.openExternal({ url: link.href }); }));
  document.body.appendChild(modal); document.addEventListener("keydown", onKey); modal.querySelector("button").focus();
}
