// The call tree's window openers: the run window (`tree:window`, ⤢ in the panel) and a subagent's transcript
// window (`tree:log:<root>:<id>`, 기록 열기). The status copy routes these commands here after sys/scan.js
// `command()` passes them on, so they work while the panel is hidden; the views call the same functions.

import { openOverlay, closeOverlay, shared, setShared } from "herdr";
import { MOD } from "../../sys/state.js";
import { find } from "../../sys/scan.js";

/** Shared key: the run window's overlay id while it is open. */
export const WINDOW_KEY = "lazuli.tree.window";

/** Opens (or brings back, in its remembered place) the run window: the shown run as a top-down card tree. */
export function openTreeWindow() {
  const id = openOverlay({ mod: MOD, kind: "window", key: "lazuli-run", width: 0.85, height: 0.9, props: { view: "run" } });
  setShared(WINDOW_KEY, id);
}

/** Closes the run window, if it is open. */
export function closeTreeWindow() {
  const id = shared(WINDOW_KEY);
  setShared(WINDOW_KEY, null);
  if (typeof id === "string" && id) closeOverlay(id);
}

/** Opens a subagent's transcript, read-only and live, in its own window (one per transcript). */
export function openTranscript(n) {
  if (!n?.file) return;
  openOverlay({
    mod: MOD,
    kind: "window",
    key: `lazuli-transcript:${n.file}`,
    width: 760,
    height: 0.8,
    props: { view: "transcript", file: n.file, root: n.root, id: n.id, name: n.name ?? null, type: n.type ?? null },
  });
}

/**
 * `tree:window`, `tree:window:close` and `tree:log:<root>:<id>`. True when `c` was one of them. The status copy
 * calls it after `scan.command(c, cx)` returned false.
 */
export function treeCommand(c) {
  if (typeof c !== "string") return false;
  if (c === "tree:window") {
    openTreeWindow();
    return true;
  }
  if (c === "tree:window:close") {
    closeTreeWindow();
    return true;
  }
  if (c.startsWith("tree:log:")) {
    const rest = c.slice("tree:log:".length);
    const at = rest.indexOf(":");
    if (at > 0) openTranscript(find(rest.slice(0, at), rest.slice(at + 1)));
    return true;
  }
  return false;
}
