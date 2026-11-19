// Cache eviction order (ARCHITECTURE §6: Markdown image cache, 200 MB): the least recently used
// files go first until the total fits. Pure.

const size = (e) => (e && typeof e.size === "number" && Number.isFinite(e.size) && e.size > 0 ? e.size : 0);

/** The sum of the entries' sizes (missing or bad sizes count 0). */
export function total(entries) {
  return (Array.isArray(entries) ? entries : []).reduce((sum, e) => sum + size(e), 0);
}

/** The names to delete so the total is at most `cap`: oldest `used` first, ties by name in code-unit
 *  order. */
export function evict(entries, cap) {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && typeof e.name === "string");
  let sum = total(list);
  if (sum <= cap) return [];
  const used = (e) => (typeof e.used === "number" && Number.isFinite(e.used) ? e.used : 0);
  const order = [...list].sort((a, b) => used(a) - used(b) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out = [];
  for (const e of order) {
    if (sum <= cap) break;
    out.push(e.name);
    sum -= size(e);
  }
  return out;
}
