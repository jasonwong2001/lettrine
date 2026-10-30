export function linkDialog({ text = "", url = "", title = "", editing = false } = {}) {
  document.getElementById("link-dialog")?.remove();
  return new Promise((resolve) => {
    const box = document.createElement("div");
    box.id = "link-dialog";
    box.className = "modal open";
    box.setAttribute("role", "dialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("aria-labelledby", "link-dialog-title");
    box.innerHTML = `<div class="modal-dialog"><form class="modal-content">
      <div class="modal-header"><h2 class="modal-title" id="link-dialog-title">${editing ? "Edit Link" : "Add Link"}</h2></div>
      <div class="modal-body">
        <label class="field" for="link-text"><span>Text</span><input id="link-text" class="ui-input" autocomplete="off"></label>
        <label class="field" for="link-url"><span>Address</span><input id="link-url" class="ui-input" placeholder="https://example.com, notes.md or #heading" required autocomplete="off" spellcheck="false"></label>
        <label class="field" for="link-title"><span>Title (optional)</span><input id="link-title" class="ui-input" autocomplete="off"></label>
        <p id="link-error" role="alert"></p>
      </div><div class="modal-footer">
        <button class="ui-btn ui-btn-danger footer-start" type="button" id="link-remove">Remove Link</button>
        <button class="ui-btn" type="button" id="link-cancel">Cancel</button>
        <button class="ui-btn ui-btn-primary" type="submit" id="link-save">${editing ? "Update" : "Add Link"}</button>
      </div></form></div>`;
    document.body.appendChild(box);
    const field = (id) => box.querySelector("#link-" + id);
    field("text").value = text;
    field("url").value = url;
    field("title").value = title;
    field("remove").hidden = !editing;
    field("remove").style.display = editing ? "" : "none";
    const done = (value) => { box.remove(); resolve(value); };
    field("cancel").onclick = () => done(null);
    field("remove").onclick = () => done({ remove: true });
    box.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); done(null); }
      if (event.key === "Tab") {
        const fields = [...box.querySelectorAll("input, button")].filter((element) => !element.hidden && element.style.display !== "none");
        const first = fields[0];
        const last = fields.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    });
    box.querySelector("form").onsubmit = (event) => {
      event.preventDefault();
      const destination = field("url").value.trim();
      if (!destination || /[\r\n]/.test(destination)) return;
      if (/^[\w+.-]+:/.test(destination) && !/^(https?:|mailto:|tel:|file:)/i.test(destination)) {
        field("error").textContent = "Use a web URL, email address, local file or document heading.";
        return;
      }
      done({ text: field("text").value, url: destination, title: field("title").value });
    };
    field("url").focus();
    field("url").select();
  });
}
