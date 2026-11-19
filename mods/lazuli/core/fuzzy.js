// Quick-open scoring (DESIGN B11): a query matches a path when its characters appear in order,
// case-insensitive. Higher scores are better. The tier decides first: an exact file name, then a
// file-name prefix, then a match inside the file name, then a match that needs the folder part;
// inside a tier a contiguous match beats a scattered one, then word-boundary hits and tight spans
// count. Pure.

const TIER = 1000000;
const CONTIGUOUS = 100000;
/** The fine score stays in [0, CONTIGUOUS). */
const FINE_BASE = 50000;

/** Lower-cased code unit by code unit, so positions in the result index the original string. */
function lower(s) {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const l = s[i].toLowerCase();
    out += l.length === 1 ? l : s[i];
  }
  return out;
}

/** Whether index `i` of `s` starts a word: the start, after a separator, or a lower→upper change. */
function boundary(s, i) {
  if (i === 0) return true;
  const prev = s[i - 1];
  if ("/._- ".includes(prev)) return true;
  return prev >= "a" && prev <= "z" && s[i] >= "A" && s[i] <= "Z";
}

/** Positions of `q` as a subsequence of `low` within [from, to), left to right, or null. */
function forward(low, q, from, to) {
  const out = [];
  let i = from;
  for (const ch of q) {
    while (i < to && low[i] !== ch) i++;
    if (i >= to) return null;
    out.push(i++);
  }
  return out;
}

/** Positions of `q` as a subsequence of `low` within [from, to), matched from the right, or null. */
function backward(low, q, from, to) {
  const out = new Array(q.length);
  let i = to - 1;
  for (let k = q.length - 1; k >= 0; k--) {
    while (i >= from && low[i] !== q[k]) i--;
    if (i < from) return null;
    out[k] = i--;
  }
  return out;
}

/** The occurrence of `q` in `low` within [from, to) that starts a word, else the last one, or -1. */
function contiguousAt(path, low, q, from, to) {
  let best = -1;
  for (let i = low.indexOf(q, from); i >= 0 && i + q.length <= to; i = low.indexOf(q, i + 1)) {
    if (boundary(path, i)) return i;
    best = i;
  }
  return best;
}

const run = (start, n) => Array.from({ length: n }, (_, k) => start + k);

function fine(path, positions) {
  let hits = 0;
  for (const p of positions) if (boundary(path, p)) hits++;
  const span = positions[positions.length - 1] - positions[0] + 1 - positions.length;
  const value = FINE_BASE + hits * 1000 - span * 50 - positions[0] * 2;
  return Math.max(0, Math.min(CONTIGUOUS - 1, value));
}

/** The match of `query` in `path`: `{score, positions}` (positions index `path`), or null. */
function match(query, path) {
  if (typeof query !== "string" || typeof path !== "string") return null;
  if (query === "") return { score: 0, positions: [] };
  const q = lower(query);
  const low = lower(path);
  if (q.length > low.length) return null;
  const start = path.lastIndexOf("/") + 1;
  const base = low.slice(start);
  if (base === q) return { score: 4 * TIER + CONTIGUOUS + fine(path, run(start, q.length)), positions: run(start, q.length) };
  if (base.startsWith(q)) return { score: 3 * TIER + CONTIGUOUS + fine(path, run(start, q.length)), positions: run(start, q.length) };
  let at = contiguousAt(path, low, q, start, low.length);
  if (at >= 0) return { score: 2 * TIER + CONTIGUOUS + fine(path, run(at, q.length)), positions: run(at, q.length) };
  let positions = forward(low, q, start, low.length);
  if (positions) return { score: 2 * TIER + fine(path, positions), positions };
  at = contiguousAt(path, low, q, 0, low.length);
  if (at >= 0) return { score: TIER + CONTIGUOUS + fine(path, run(at, q.length)), positions: run(at, q.length) };
  positions = backward(low, q, 0, low.length);
  return positions ? { score: TIER + fine(path, positions), positions } : null;
}

/** The score of `query` against `path`, or null unless the query is a case-insensitive
 *  subsequence of it. An empty query scores 0. */
export function score(query, path) {
  return match(query, path)?.score ?? null;
}

/** The best `limit` matches, best first; ties go to the shorter path, then code-unit order. An empty
 *  query keeps the first `limit` paths in input order with score 0. */
export function rank(query, paths, limit = 50) {
  const list = Array.isArray(paths) ? paths.filter((p) => typeof p === "string") : [];
  const max = Number.isInteger(limit) && limit >= 0 ? limit : 50;
  if (query === "" || typeof query !== "string") return list.slice(0, max).map((path) => ({ path, score: 0, positions: [] }));
  const out = [];
  for (const path of list) {
    const m = match(query, path);
    if (m) out.push({ path, score: m.score, positions: m.positions });
  }
  out.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out.slice(0, max);
}
