import { acceleratorFromEvent, normalizeAccelerator } from "../core/shortcuts.js";
let shortcuts = [];
let loaded = false;
const MENU_ORDER = ["Lettrine", "File", "Edit", "Format", "View", "Window", "Help"];

// Accelerators are stored as "CmdOrCtrl+Alt+J" and shown the Mac way: ⌥⌘J.
export function acceleratorLabel(value) {
  if (!value) return "";
  const parts = value.split("+"), key = parts.pop();
  const mods = new Set(parts.map((part) => part.toLowerCase()));
  const symbols = [["ctrl", "⌃"], ["alt", "⌥"], ["shift", "⇧"]].filter(([name]) => mods.has(name)).map(([, symbol]) => symbol);
  if (mods.has("cmdorctrl") || mods.has("cmd") || mods.has("super")) symbols.push("⌘");
  const keys = { Up: "↑", Down: "↓", Left: "←", Right: "→", Enter: "↩", Backspace: "⌫", Delete: "⌦", Escape: "⎋", Tab: "⇥", Space: "Space", Plus: "+", PageUp: "⇞", PageDown: "⇟", Home: "↖", End: "↘" };
  return symbols.join("") + (keys[key] || key.toUpperCase());
}

function setAccelerator(input, value) {
  input.dataset.accelerator = value || "";
  input.value = acceleratorLabel(value);
  input.placeholder = "—";
}

export function initShortcutPreferences() {
  const pane = document.createElement("section"); pane.className = "pref-pane"; pane.id = "pref-pane-shortcuts"; pane.hidden = true; pane.setAttribute("aria-label", "Shortcuts");
  const head = document.createElement("div"); head.className = "pref-stack shortcut-head";
  const filter = document.createElement("input"); filter.type = "search"; filter.id = "pref-shortcuts-filter"; filter.placeholder = "Filter commands"; filter.setAttribute("aria-label", "Filter commands"); filter.autocomplete = "off"; filter.spellcheck = false;
  filter.addEventListener("input", () => {
    const query = filter.value.trim().toLowerCase();
    for (const row of pane.querySelectorAll(".shortcut-row")) row.hidden = !!query && !row.dataset.search.includes(query);
    for (const group of pane.querySelectorAll(".shortcut-group")) group.hidden = ![...group.querySelectorAll(".shortcut-row")].some((row) => !row.hidden);
  });
  const hint = document.createElement("p"); hint.className = "pref-hint"; hint.textContent = "Click a shortcut, then press the new key combination. Delete removes it.";
  const reset = document.createElement("button"); reset.type = "button"; reset.className = "ui-btn"; reset.textContent = "Restore Defaults";
  reset.onclick = () => { for (const item of shortcuts) setAccelerator(pane.querySelector(`[data-command="${item.command}"]`), item.default || ""); };
  const actions = document.createElement("div"); actions.className = "pref-actions"; actions.append(hint, reset);
  head.append(filter, actions);
  const table = document.createElement("div"); table.id = "pref-shortcuts-list";
  pane.append(head, table); document.querySelector("#preferences-dialog .settings-panes").appendChild(pane);
}
export async function loadShortcutPreferences(preserveChanges = false) {
  if (!window.bridge.menu?.shortcuts) return;
  loaded = false;
  shortcuts = await window.bridge.menu.shortcuts();
  const previous = new Map(preserveChanges ? [...document.querySelectorAll("#pref-shortcuts-list input")].map((input) => [input.dataset.command, input.dataset.accelerator]) : []);
  const list = document.getElementById("pref-shortcuts-list"); list.replaceChildren();
  const groups = new Map();
  for (const item of shortcuts) {
    const menu = item.menu || "Other";
    if (!groups.has(menu)) {
      const title = document.createElement("h3"); title.className = "pref-group-title"; title.textContent = menu === "Lettrine" ? "Application" : menu;
      const group = document.createElement("div"); group.className = "pref-group";
      const wrapper = document.createElement("div"); wrapper.className = "shortcut-group"; wrapper.dataset.menu = menu; wrapper.append(title, group);
      groups.set(menu, wrapper);
    }
    const label = document.createElement("label"); label.className = "pref-row shortcut-row";
    const text = document.createElement("span"); text.className = "pref-label"; text.textContent = item.label;
    const input = document.createElement("input"); input.type = "text"; input.readOnly = true; input.dataset.command = item.command; input.setAttribute("aria-label", item.label + " shortcut");
    setAccelerator(input, previous.get(item.command) ?? item.accelerator ?? "");
    label.dataset.search = (item.label + " " + input.value + " " + menu).toLowerCase();
    input.onfocus = () => window.bridge.menu.recording({ enabled: true });
    input.onblur = () => window.bridge.menu.recording({ enabled: false });
    input.onkeydown = (event) => {
      if (event.key === "Tab" && !event.metaKey && !event.ctrlKey && !event.altKey) return;
      event.preventDefault(); event.stopPropagation();
      if ((event.key === "Backspace" || event.key === "Delete") && !event.metaKey && !event.ctrlKey && !event.altKey) { setAccelerator(input, ""); return; }
      try { const value = acceleratorFromEvent(event, /Mac/.test(navigator.platform) ? "darwin" : "linux"); if (value) setAccelerator(input, value); } catch { /* wait for a supported key */ }
    };
    label.append(text, input); groups.get(menu).querySelector(".pref-group").appendChild(label);
  }
  for (const menu of [...groups.keys()].sort((a, b) => (MENU_ORDER.indexOf(a) + 1 || 99) - (MENU_ORDER.indexOf(b) + 1 || 99))) list.appendChild(groups.get(menu));
  loaded = true;
}
export function shortcutPreferencesPatch() {
  if (!loaded) return undefined;
  const result = {}, used = new Map();
  for (const input of document.querySelectorAll("#pref-shortcuts-list input")) {
    const value = normalizeAccelerator(input.dataset.accelerator || ""); const command = input.dataset.command;
    if (value && used.has(value)) throw Error(`${acceleratorLabel(value)} is assigned twice. Choose another shortcut or clear one of them.`);
    if (value) used.set(value, command);
    const item = shortcuts.find((item) => item.command === command);
    if (value !== normalizeAccelerator(item.default || "")) result[command] = value;
  }
  return result;
}
