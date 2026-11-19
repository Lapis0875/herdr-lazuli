// The HTML viewer pane of a file tab (DESIGN B6–B8, ARCHITECTURE §5–§6) as data: what the mode wants
// (none, beside the editor, zoomed over the tab), what the panes show, and the Herdr commands that
// get from one to the other. The viewer (`bin/html-view.mjs`) sets its title `lazuli-view:<fid8>`
// (a pane is found by it) and labels its terminal `lazuli.view=<fid>` (a stale one is found by it).

import { appHome, exec, panes, terminals } from "herdr";
import { fid8 } from "../sys/filetabs.js";
import { language } from "../core/i18n.js";

/** A viewer pane this young may not have set its title yet. */
export const VIEWER_GRACE_MS = 8000;

let browser = null;

/** Whether a browser the viewer can drive is installed (B8 order, the paths html-view.mjs looks at).
 *  Asked once per start. */
export function browserAvailable() {
  if (!browser) {
    const look = [
      'for d in /Applications "$HOME/Applications"; do',
      '  for b in "Google Chrome.app/Contents/MacOS/Google Chrome" "Chromium.app/Contents/MacOS/Chromium" "Microsoft Edge.app/Contents/MacOS/Microsoft Edge" "Brave Browser.app/Contents/MacOS/Brave Browser"; do',
      '    [ -x "$d/$b" ] && exit 0',
      "  done",
      "done",
      "exit 1",
    ].join("\n");
    browser = exec("sh", ["-c", look], { timeout: 5000 }).then((r) => r.code === 0, () => false);
  }
  return browser;
}

/** The viewer pane's state for a file tab.
 *  `o`: {fid, file, kind, mode, on, ready, chrome (Markdown "View in Chrome"), browser (null unknown),
 *  tab, pane (the tab's lazuli pane), viewerFile (the file the viewer was split for; null: unknown),
 *  splitAt (ms of the last split), now}.
 *  Returns `{want, have, pane, steps, fallback}`: `want`/`have` "none" | "split" | "zoomed" (`have`
 *  "unknown" before the tab's ids are known), the viewer's pane, `steps` as `{command, args}` for
 *  run(), and `fallback` when no browser is installed (the view shows html-fallback instead). */
export function viewerState(o) {
  let want = "none";
  if (!o.on && o.ready) {
    if (o.kind === "html") want = o.mode === "split" ? "split" : o.mode === "preview" ? "zoomed" : "none";
    else if (o.kind === "md" && o.chrome) want = "split";
  }
  const fallback = want !== "none" && o.browser === false;
  if (!o.tab || !o.pane) return { want, have: "unknown", pane: null, steps: [], fallback };
  const terms = panes().filter((p) => p.tab === o.tab && p.terminal);
  const view = terms.find((p) => p.title === `lazuli-view:${fid8(o.fid)}`) ?? null;
  const starting = o.now - o.splitAt < VIEWER_GRACE_MS;
  const steps = [];
  // A stale viewer: a terminal the viewer labelled `lazuli.view=<fid>` that no longer shows its title,
  // e.g. after a restart (a lost terminal's command never runs again). Any other pane stays.
  if (!starting) {
    const others = terms.filter((p) => p !== view);
    const labelled = others.length ? new Set(terminals().filter((t) => t?.labels?.["lazuli.view"] === o.fid).map((t) => t.address)) : null;
    for (const p of others) if (labelled.has(p.terminal)) steps.push({ command: "pane.close", args: { pane: p.pane } });
  }
  const target = fallback ? "none" : want;
  // A preview tab that switched files: its viewer still shows the old one.
  const wrong = view && o.viewerFile !== null && o.viewerFile !== o.file;
  if (target === "none" || wrong) {
    if (view) steps.push({ command: "pane.close", args: { pane: view.pane } });
  } else if (!view) {
    if (!starting) {
      const argv = ["node", `${appHome()}/mods/lazuli/bin/html-view.mjs`, "--fid", o.fid, "--file", o.file, "--kind", o.kind === "md" ? "md" : "html", "--lang", language()];
      steps.push({ command: "pane.split", args: { direction: "right", pane: o.pane, argv } });
    }
  } else if ((target === "split") === view.zoomed) steps.push({ command: "pane.zoom", args: { pane: view.pane } });
  return { want, have: view ? (view.zoomed ? "zoomed" : "split") : "none", pane: view?.pane ?? null, steps, fallback };
}
