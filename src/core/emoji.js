// `:name:` emoji completion over GitHub's emoji names (gemoji, generated
// into ./vendor by scripts/make-emoji.mjs).
import { EMOJI_DATA } from "./vendor/emoji-data.js";
import { EMOJI_SEARCH } from "./vendor/emoji-search.js";

const EMOJI = { ...EMOJI_DATA };

const byName = new Map();
for (const [name, char] of Object.entries(EMOJI)) byName.set(name, char);

/**
 * Complete an emoji name against the table (exact → prefix).
 * @param {string} name
 * @returns {string|null}
 */
export function completeEmoji(name) {
  const key = (name || "").toLowerCase();
  if (byName.has(key)) return byName.get(key);
  for (const [k, v] of byName) if (k.startsWith(key)) return v;
  return null;
}

/**
 * Candidates for the completion popup, in this order:
 *   1. the exact typed name itself (if it is a known emoji)
 *   2. names starting with the prefix
 *   3. keyword hits from the search index (keyword → [names]), in index order
 * Returns ":name:" strings.
 */
export function emojiMatches(prefix, limit = 8) {
  const key = (prefix || "").toLowerCase();
  if (!key) return [];
  const names = [];
  const push = (n) => { if (!names.includes(n) && byName.has(n)) names.push(n); };
  if (byName.has(key)) names.push(key);
  for (const name of byName.keys()) {
    if (name.startsWith(key)) push(name);
    if (names.length >= limit) break;
  }
  const hits = EMOJI_SEARCH[key];
  if (hits) for (const n of hits) { push(n); if (names.length >= limit) break; }
  return names.slice(0, limit).map((n) => ":" + n + ":");
}
