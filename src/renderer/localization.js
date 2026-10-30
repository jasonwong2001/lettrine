// Interface text is written in English and translated in place: each text
// node and label attribute whose English text has a translation shows it.
// `active.strings` maps English to the active language (src/locales).
const textKeys = new WeakMap(), attributeKeys = new WeakMap();
let active = { locale: "en", strings: {} };
const UI = "#app-sidebar, #doc-bar, #document-toolbar, #zoom-popover, #doc-popover, #preferences-dialog, #md-searchpanel, #quick-open, #table-insert-dialog, #ic-oversize-body, .md-notification-container, .modal, .dropdown-menu, .md-frontmatter-caption, .md-math-toolbar, .md-alert-title, .md-lang-input, .ui-code-languages";
// Language names are already written in their own language.
const USER_CONTENT = ".file-list-item, .search-match-row, .outline-row, .quick-open-item, #quick-open-empty, #titlebar-document-name, #library-name, #doc-info-name, #doc-info-path, #doc-info-meta, .toast-text, .alert-message, .alert-detail, #prompt-name, #pref-shortcuts-list input, #pref-dictionary-path, #pref-locale";
const translated = (key) => active.strings[key] ?? key;
export const translateUI = translated;
export function localizeUI(data = active, root = document.body) {
  active = { locale: data.locale || "en", strings: data.strings || {} };
  document.documentElement.lang = active.locale;
  const containers = root.closest?.(UI) ? [root] : Array.from(root.querySelectorAll?.(UI) || []);
  for (const container of containers) {
    const walker = document.createTreeWalker(container, 4);
    for (let node; (node = walker.nextNode());) {
      const parent = node.parentElement;
      if (!parent || parent.closest(USER_CONTENT) || /^(SCRIPT|STYLE|TEXTAREA)$/.test(parent.tagName)) continue;
      const original = textKeys.get(node) || node.data;
      const key = original.trim(); if (!key) continue;
      const value = translated(key);
      if (value !== key || textKeys.has(node)) {
        textKeys.set(node, original);
        const replacement = original.replace(key, value);
        if (node.data !== replacement) node.data = replacement;
      }
    }
    for (const element of [container, ...container.querySelectorAll("[title], [placeholder], [aria-label]")]) {
      if (element.closest(USER_CONTENT)) continue;
      let keys = attributeKeys.get(element); if (!keys) attributeKeys.set(element, keys = {});
      for (const attribute of ["title", "placeholder", "aria-label"]) {
        const original = keys[attribute] ?? element.getAttribute(attribute);
        if (!original) continue;
        const value = translated(original);
        if (value !== original || keys[attribute] !== undefined) { keys[attribute] = original; if (element.getAttribute(attribute) !== value) element.setAttribute(attribute, value); }
      }
    }
  }
}
export function initLocalization() {
  const options = { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["title", "placeholder", "aria-label"] };
  const observer = new window.MutationObserver((mutations) => {
    const roots = new Set();
    for (const mutation of mutations) {
      const target = mutation.target.nodeType === 1 ? mutation.target : mutation.target.parentElement;
      const root = target?.closest?.(UI); if (root && !target.closest(USER_CONTENT)) roots.add(target);
      for (const node of mutation.addedNodes || []) if (node.nodeType === 1 && (node.matches(UI) || node.querySelector(UI))) {
        roots.add(node);
        if (node.parentNode === document.body) observer.observe(node, options);
      }
    }
    for (const root of roots) localizeUI(active, root);
  });
  // Watch the interface only: observing the document would queue a record
  // for every keystroke and rendered block. Dialogs and menus are added to
  // the body, and are watched from then on.
  observer.observe(document.body, { childList: true });
  for (const container of document.querySelectorAll(UI)) observer.observe(container, options);
}
export function initLocalePreference() {
  const row = document.createElement("label"); row.className = "pref-row";
  const label = document.createElement("span"); label.textContent = "Language";
  const select = document.createElement("select"); select.id = "pref-locale";
  select.onchange = () => { void window.bridge.i18n.setLocale({ locale: select.value }).catch((error) => window.__lettrineNotify?.(error.message)); };
  label.className = "pref-label";
  row.append(label, select); document.querySelector('#preferences-dialog [data-pref-group="general-language"]').appendChild(row);
}
export async function loadLocalePreference() {
  const state = await window.bridge.i18n.locales(), select = document.getElementById("pref-locale");
  select.replaceChildren();
  for (const locale of state.list) { const option = document.createElement("option"); option.value = locale.key; option.textContent = locale.name; select.appendChild(option); }
  select.value = state.locale;
}
