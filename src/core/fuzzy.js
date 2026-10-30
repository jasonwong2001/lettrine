// Lettrine Quick Open fuzzy matching: the query is matched as a
// case-insensitive *subsequence* of the file name and ranked by quality.
// Prefix / path-boundary / contiguous-run matches score higher.
//
// Returns a numeric score (higher = better) or null when the query is not a
// subsequence of the name.

export function fuzzyScore(query, name) {
  const q = String(query || "").toLowerCase();
  if (!q) return 0;
  const s = String(name || "").toLowerCase();
  let qi = 0;
  let score = 0;
  let lastMatch = -2;
  for (let si = 0; si < s.length && qi < q.length; si++) {
    if (s[si] === q[qi]) {
      if (si === lastMatch + 1) score += 4; // contiguous run
      else score += 1;
      if (si === 0 || "/.\\- _".includes(s[si - 1])) score += 6; // boundary
      score -= Math.floor(si / 8); // prefer earlier matches
      lastMatch = si;
      qi++;
    }
  }
  return qi < q.length ? null : score;
}

// Rank a list of {name, ...} items against a query, keeping only matches,
// sorted best-first. Empty query keeps original order.
export function fuzzyRank(items, query) {
  const out = [];
  for (const it of items) {
    const s = fuzzyScore(query, it.name);
    if (s !== null) out.push({ ...it, _score: s });
  }
  out.sort((a, b) => b._score - a._score);
  return out;
}
