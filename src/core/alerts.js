export const ALERT_LABELS = {
  note: "Note", tip: "Tip", important: "Important", warning: "Warning", caution: "Caution",
};

// Only a marker at the start of a quote's first paragraph is an alert.
export function alertMarker(source) {
  const match = /^(\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\])(?=[ \t\n]|$)([ \t]*(?:\n|$))?/i.exec(source);
  return match ? { type: match[2].toLowerCase(), prefix: match[0] } : null;
}

export function alertIcon(type) {
  const paths = {
    note: '<circle cx="8" cy="8" r="6"/><path d="M8 7v4M8 4.5v.5"/>',
    tip: '<path d="M6 12h4M6.5 14h3M5.5 9.5a4.5 4.5 0 1 1 5 0c-.8.6-1 1.1-1 2.5h-3c0-1.4-.2-1.9-1-2.5Z"/>',
    important: '<path d="M2 2h12v9H8l-4 3v-3H2ZM8 4v3M8 8.5v.5"/>',
    warning: '<path d="m8 1.5 7 12H1ZM8 5.5v4M8 11v.5"/>',
    caution: '<path d="M5 1.5h6L14.5 5v6L11 14.5H5L1.5 11V5ZM8 4.5v4M8 10.5v1"/>',
  };
  return `<svg class="md-alert-icon" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[type] || paths.note}</svg>`;
}
