// The file-tab registry (ARCHITECTURE §6): `shared("lazuli.tabs")`, one entry per file tab by fid,
// `{file, on, preview, mode, space, tab, pane, at}`. These reducers decide what opening a file does
// (select, retarget the preview tab, or a new tab), bind a copy to its ids, and drop stale entries.
// Pure: ids and time are arguments; inputs are never changed.

import { fileKey, normalize, tabName } from "./paths.js";

/** A tab with no ids yet is dropped this long after it was opened. */
const UNBOUND_MS = 60000;
/** Ticks in a row an entry's tab must be missing before it is dropped. */
const MAX_MISSES = 2;

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const entries = (reg) => (isPlain(reg) ? Object.entries(reg).filter(([, e]) => isPlain(e) && typeof e.file === "string") : []);
const machine = (on) => (typeof on === "string" && on !== "" ? on : null);

/** The fid of the tab showing that file in that space, or null. */
export function findOpen(reg, q) {
  const key = fileKey(q?.file, q?.on);
  for (const [fid, e] of entries(reg)) {
    if (e.space === q?.space && fileKey(e.file, e.on) === key) return fid;
  }
  return null;
}

/** The fid of the space's preview tab, or null. */
export function previewOf(reg, space) {
  for (const [fid, e] of entries(reg)) {
    if (e.preview === true && e.space === space) return fid;
  }
  return null;
}

/** What opening a file does (B2):
 *  - `{action: "select", fid}`: the file is open in that space already;
 *  - `{action: "retarget", fid, reg, name}`: not pinned, and the space's preview tab has no unsaved
 *    edits (`dirty` lists fids that must not be retargeted): it shows the file instead;
 *  - `{action: "new", fid, reg, name, props}`: a new tab; `props` are its mod props. */
export function openPlan(reg, q) {
  const base = isPlain(reg) ? reg : {};
  const file = normalize(q?.file);
  const on = machine(q?.on);
  const found = findOpen(base, { file, on, space: q?.space });
  if (found) return { action: "select", fid: found };
  const pin = q?.pin === true;
  if (!pin) {
    const preview = previewOf(base, q?.space);
    const keep = Array.isArray(q?.dirty) ? q.dirty : [];
    if (preview && !keep.includes(preview)) {
      return {
        action: "retarget",
        fid: preview,
        reg: { ...base, [preview]: { ...base[preview], file, on, mode: null, at: q?.now } },
        name: tabName(file, { preview: true, dirty: false }),
      };
    }
  }
  const fid = q?.fid;
  return {
    action: "new",
    fid,
    reg: { ...base, [fid]: { file, on, preview: !pin, mode: null, space: q?.space ?? null, tab: null, pane: null, at: q?.now } },
    name: tabName(file, { preview: !pin, dirty: false }),
    props: { view: "file", fid, file, on, preview: !pin },
  };
}

function change(reg, fid, fields) {
  if (!isPlain(reg) || !own(reg, fid) || !isPlain(reg[fid])) return reg;
  return { ...reg, [fid]: { ...reg[fid], ...fields } };
}

/** The entry made a normal tab (a first edit or a double click). Unknown fid → the same reg. */
export function pin(reg, fid) {
  return change(reg, fid, { preview: false });
}

/** The mode the entry wants (null: the kind's default). Unknown fid → the same reg. */
export function setMode(reg, fid, mode) {
  return change(reg, fid, { mode: typeof mode === "string" ? mode : null });
}

/** The entry's space, tab and pane, as its copy found them at render. Unknown fid → the same reg. */
export function bind(reg, fid, ids) {
  return change(reg, fid, { space: ids?.space ?? null, tab: ids?.tab ?? null, pane: ids?.pane ?? null });
}

/** The first of `tabs` that no other fid holds, or null. */
export function claim(reg, fid, tabs) {
  const held = new Set(entries(reg).filter(([k, e]) => k !== fid && e.tab).map(([, e]) => e.tab));
  for (const tab of Array.isArray(tabs) ? tabs : []) {
    if (typeof tab === "string" && !held.has(tab)) return tab;
  }
  return null;
}

/** One pruning tick: an entry whose tab is not in `liveTabs` gets a miss and goes at the second in a
 *  row; a live entry's misses reset; an entry with no tab goes once `now − at > 60000`. Misses of
 *  fids no longer in the registry are dropped. */
export function sweep(reg, liveTabs, misses, now) {
  const live = new Set(Array.isArray(liveTabs) ? liveTabs : []);
  const before = isPlain(misses) ? misses : {};
  const out = {};
  const left = {};
  for (const [fid, e] of Object.entries(isPlain(reg) ? reg : {})) {
    if (!isPlain(e)) continue;
    if (!e.tab) {
      if (!(now - (typeof e.at === "number" ? e.at : 0) > UNBOUND_MS)) out[fid] = e;
      continue;
    }
    if (live.has(e.tab)) {
      out[fid] = e;
      continue;
    }
    const count = (typeof before[fid] === "number" ? before[fid] : 0) + 1;
    if (count >= MAX_MISSES) continue;
    out[fid] = e;
    left[fid] = count;
  }
  return { reg: out, misses: left };
}
