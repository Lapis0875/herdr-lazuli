// A file tab's header, shared with the pane header (DESIGN B2–B7, mockup A: one header row per file
// tab). Each file copy publishes its header state (headStateOf) in shared("lazuli.filehead")[fid]
// and keeps its live instance in this module's registry (module state is shared by every copy, F3),
// so another copy can draw the header (fileHeader) and act on it (fileHeadActions) without commands.
//
// For views/pane-head.js (inside the lazuli layout, whose tab block names lazuli's pane-head):
//   const head = fileHeadFor(props().pane);      // render-safe; null when the pane is no file tab's
//   if (head) return fileHeader(head.state, { compact: true, width, ...fileHeadActions(head.fid) });
// `head.viewer` is true on an HTML tab's viewer pane (same fid), so the header follows it there too.
// A file tab draws the header itself only where no pane header does it (paneHeadDrawsFileHeads()).

import { layout, panes, setShared, shared } from "herdr";
import { MOD } from "../../sys/state.js";
import { fid8, pin, registry } from "../../sys/filetabs.js";
import { kindOf } from "../../core/paths.js";
import { fileHeader, headStateOf } from "./header.js";

export { fileHeader, headStateOf };

/** shared key: `{[fid]: headStateOf(...)}`, written by the file copies on a change. */
export const FILEHEAD_KEY = "lazuli.filehead";

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// fid → the live FileTab instance, and fid → the JSON last published.
const live = new Map();
const published = new Map();

/** A file copy registers itself in init (`tab`: {setMode(mode, cx), toggleChrome(cx), publish()}). */
export function registerFileTab(fid, tab) {
  if (fid) live.set(fid, tab);
}

/** Whether `state` differs from what was last published for this fid. Render-safe. */
export function headChanged(fid, state) {
  return Boolean(fid) && published.get(fid) !== JSON.stringify(state);
}

/** Publishes a tab's header state when it changed (outside render: it writes shared state, which
 *  redraws every copy). Entries of tabs no longer in the file-tab registry are dropped on the way. */
export function publishHead(fid, state) {
  if (!fid) return false;
  const json = JSON.stringify(state);
  if (published.get(fid) === json) return false;
  published.set(fid, json);
  const reg = registry();
  const cur = shared(FILEHEAD_KEY);
  const next = {};
  if (isPlain(cur)) for (const [f, s] of Object.entries(cur)) if (f !== fid && isPlain(reg[f])) next[f] = s;
  next[fid] = state;
  setShared(FILEHEAD_KEY, next);
  return true;
}

/** The copy closes: its registry slot and published state go. */
export function dropHead(fid) {
  if (!fid) return;
  live.delete(fid);
  published.delete(fid);
  const cur = shared(FILEHEAD_KEY);
  if (isPlain(cur) && Object.prototype.hasOwnProperty.call(cur, fid)) {
    const { [fid]: _gone, ...rest } = cur;
    setShared(FILEHEAD_KEY, rest);
  }
}

/** The viewer pane of a file tab as the panes show it now: "none" | "split" | "zoomed", or null when
 *  the tab is not known yet. Render-safe. */
export function viewerHave(fid) {
  const tab = registry()[fid]?.tab;
  if (!tab) return null;
  const view = panes().find((p) => p.tab === tab && p.terminal && p.title === `lazuli-view:${fid8(fid)}`);
  return view ? (view.zoomed ? "zoomed" : "split") : "none";
}

// The published state with what depends on the viewer pane taken from the panes now: the file copy
// does not draw (or publish) while a zoomed viewer covers it, so its own view of the pane goes stale.
function withViewer(s, fid) {
  if (!s.viewerWant) return s;
  const have = viewerHave(fid);
  if (have === null) return s;
  const busy = s.busy === "filetab.viewer.checking" ? s.busy : s.viewerWant !== "none" && have !== s.viewerWant ? "filetab.viewer.starting" : null;
  let mode = s.mode;
  if (s.kind === "html" && have !== "none") mode = have === "zoomed" ? "preview" : "split";
  return busy === s.busy && mode === s.mode ? s : { ...s, busy, mode };
}

/** The header state of a fid: the published one (its viewer progress and an HTML tab's mode read from
 *  the panes now), else a first one from the file-tab registry (before the tab drew once). Null when
 *  the fid is unknown. Render-safe. */
export function headState(fid) {
  const cur = shared(FILEHEAD_KEY);
  if (isPlain(cur) && isPlain(cur[fid])) return withViewer(cur[fid], fid);
  const e = registry()[fid];
  if (!isPlain(e) || typeof e.file !== "string") return null;
  return {
    fid, path: e.file, on: e.on || null, kind: kindOf(e.file), status: "loading", preview: e.preview === true, dirty: false,
    save: null, draft: false, reason: null, mode: null, modes: [], chrome: null, busy: null, viewerWant: null,
  };
}

/** The file tab a pane belongs to: `{fid, state, viewer}` for a file tab's lazuli pane (viewer false)
 *  or its HTML viewer pane (title `lazuli-view:<fid8>`, viewer true; its state carries `viewerPane`,
 *  so fileHeader draws a plain "Chrome view of <file>" line there, plus the Edit / Split / Preview
 *  switch only while the viewer is zoomed over the tab (`viewerZoomed`: HTML Preview, where no other
 *  header shows)); null for any other pane. Render-safe. */
export function fileHeadFor(paneId) {
  if (typeof paneId !== "string" || !paneId) return null;
  const reg = registry();
  let fid = Object.keys(reg).find((f) => isPlain(reg[f]) && reg[f].pane === paneId) ?? null;
  let viewer = null;
  if (!fid) {
    const p = panes().find((x) => x.pane === paneId);
    const m = typeof p?.title === "string" ? p.title.match(/^lazuli-view:(.+)$/) : null;
    if (!m) return null;
    fid = Object.keys(reg).find((f) => isPlain(reg[f]) && reg[f].tab === p.tab && fid8(f) === m[1]) ?? null;
    viewer = p;
  }
  const state = fid ? headState(fid) : null;
  if (!state) return null;
  return { fid, state: viewer ? { ...state, viewerPane: true, viewerZoomed: viewer.zoomed === true } : state, viewer: Boolean(viewer) };
}

/** Handlers for fileHeader() that act on the file copy of `fid` from any copy:
 *  `{onMode(mode, cx), onPin(cx), onChrome(cx)}`. Each publishes the tab's new header at once. */
export function fileHeadActions(fid) {
  return {
    onMode: (mode, cx) => {
      const tab = live.get(fid);
      if (!tab) return;
      tab.setMode(mode, cx);
      tab.publish();
    },
    onPin: (cx) => {
      pin(fid);
      live.get(fid)?.publish();
      cx.notify();
    },
    onChrome: (cx) => {
      const tab = live.get(fid);
      if (!tab) return;
      tab.toggleChrome(cx);
      tab.publish();
    },
  };
}

// Whether a tab block of the shown layout frames its panes with lazuli's pane-head: true / false, or
// null when the tree carries no tab block to tell.
function scan(node) {
  if (!isPlain(node)) return null;
  let seen = null;
  const c = node.content;
  if (isPlain(c) && "tab" in c) {
    const h = c.pane?.header?.content;
    if (isPlain(h) && h.mod === MOD && h.props?.view === "pane-head") return true;
    seen = false;
  }
  for (const child of [...(Array.isArray(node.children) ? node.children : []), ...(Array.isArray(node.floating) ? node.floating : [])]) {
    const r = scan(child);
    if (r === true) return true;
    if (r === false) seen = false;
  }
  return seen;
}

/** Whether the shown layout's pane header draws file tabs' headers: a tab block whose pane header is
 *  lazuli's pane-head; when layout() does not tell, the shown layout being `lazuli` (shared("layout")).
 *  Render-safe. */
export function paneHeadDrawsFileHeads() {
  let tree = null;
  try {
    tree = layout();
  } catch {
    tree = null;
  }
  const r = scan(tree);
  return r ?? shared("layout") === MOD;
}
