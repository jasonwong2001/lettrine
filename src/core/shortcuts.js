export const DEFAULT_SHORTCUTS = {
  "inline.strong": "CmdOrCtrl+B", "inline.emphasis": "CmdOrCtrl+I", "inline.code": "CmdOrCtrl+E",
  "inline.underline": "CmdOrCtrl+Shift+U", "view.readonly": "CmdOrCtrl+Alt+R",
  "inline.link": "CmdOrCtrl+K", "inline.image": "CmdOrCtrl+Shift+K", "edit.copyMarkdown": "CmdOrCtrl+Shift+C",
  "file.openQuickly": "CmdOrCtrl+Shift+O", "edit.find": "CmdOrCtrl+F", "edit.replace": "CmdOrCtrl+Alt+F",
  "view.focus": "F8", "view.typewriter": "F9", "view.source": "CmdOrCtrl+/", "file.reopenClosed": "CmdOrCtrl+Shift+T",
  "view.switchDocs": "CmdOrCtrl+`", "library.duplicate": "CmdOrCtrl+D", "file.new": "CmdOrCtrl+N", "window.newTab": "CmdOrCtrl+T",
  "file.save": "CmdOrCtrl+S", "file.saveAs": "CmdOrCtrl+Shift+S", "file.preferences": "CmdOrCtrl+,",
  ...Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => ["paragraph.h" + n, "CmdOrCtrl+Alt+" + n])),
};
const MODS = { cmd: "Cmd", command: "Cmd", ctrl: "Ctrl", control: "Ctrl", cmdorctrl: "CmdOrCtrl", commandorcontrol: "CmdOrCtrl", alt: "Alt", option: "Alt", shift: "Shift", super: "Super", meta: "Cmd" };
const KEYS = { return: "Enter", enter: "Enter", escape: "Escape", esc: "Escape", backspace: "Backspace", delete: "Delete", tab: "Tab", space: "Space", spacebar: "Space", up: "Up", arrowup: "Up", down: "Down", arrowdown: "Down", left: "Left", arrowleft: "Left", right: "Right", arrowright: "Right", home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", plus: "Plus" };
const PHYSICAL_KEYS = { Backquote: "`", Slash: "/", Comma: ",", Period: ".", BracketLeft: "[", BracketRight: "]", Backslash: "\\", Equal: "=", Minus: "-", Semicolon: ";" };
const physicalKey = (event) => event.code?.startsWith("Key") ? event.code.slice(3) : event.code?.startsWith("Digit") ? event.code.slice(5) : PHYSICAL_KEYS[event.code] || event.key;
export function normalizeAccelerator(value) {
  if (!value?.trim()) return "";
  const parts = value.split("+").map((part) => part.trim());
  const raw = parts.pop(), modifiers = new Set();
  for (const part of parts) { const mod = MODS[part.toLowerCase()]; if (!mod) throw Error("Unknown shortcut modifier: " + part); modifiers.add(mod); }
  const key = KEYS[raw.toLowerCase()] || (/^f(?:[1-9]|1\d|2[0-4])$/i.test(raw) ? raw.toUpperCase() : raw.length === 1 && /[\w/,.\\`\[\]\-=;]/.test(raw) ? raw.toUpperCase() : null);
  if (!key) throw Error("Unknown shortcut key: " + raw);
  if (!modifiers.size && !/^F\d+$/.test(key)) throw Error("Use a modifier key or a function key for a shortcut.");
  return [...["CmdOrCtrl", "Cmd", "Ctrl", "Super", "Alt", "Shift"].filter((mod) => modifiers.has(mod)), key].join("+");
}
export function shortcutMatches(input, accelerator, platform = "darwin") {
  if (!accelerator) return false;
  const parts = normalizeAccelerator(accelerator).split("+"); const key = parts.pop();
  const mods = new Set(parts);
  if (mods.has("CmdOrCtrl")) mods.add(platform === "darwin" ? "Cmd" : "Ctrl");
  const meta = mods.has("Cmd") || mods.has("Super");
  const raw = physicalKey(input);
  const actual = KEYS[String(raw).toLowerCase()] || (raw === " " ? "Space" : raw === "+" ? "Plus" : String(raw).toUpperCase());
  return actual === key && !!input.meta === meta && !!input.control === mods.has("Ctrl") && !!input.alt === mods.has("Alt") && !!input.shift === mods.has("Shift");
}
export function acceleratorFromEvent(event, platform = "darwin") {
  if (["Meta", "Control", "Alt", "Shift"].includes(event.key)) return null;
  const raw = physicalKey(event), key = KEYS[raw.toLowerCase()] || raw;
  return normalizeAccelerator([...(event.metaKey ? [platform === "darwin" ? "CmdOrCtrl" : "Super"] : []), ...(event.ctrlKey ? [platform === "darwin" ? "Ctrl" : "CmdOrCtrl"] : []), ...(event.altKey ? ["Alt"] : []), ...(event.shiftKey ? ["Shift"] : []), key === "+" ? "Plus" : key].join("+"));
}
