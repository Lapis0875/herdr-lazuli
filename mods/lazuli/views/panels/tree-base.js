// What the call tree panel (views/tree.js) and the run window (views/run.js) share: the shared view state (scope,
// view, hide finished, selection), the scans behind what they show (only while someone sees them), the clock that
// words durations, and the scope and hide controls. A preview copy scans nothing and its controls do nothing.

import { props, shared, setShared, checking } from "herdr";
import { t } from "../../core/i18n.js";
import { Segmented, CheckBox } from "../../ui/kit.js";
import {
  TREE, refresh, rootsFor, flatten, isOpen, selection, find, ensureDetail, refreshRun, openCall, ensureCall, runOf, markSeen,
} from "../../sys/scan.js";
import { runRoot, drawnKeys } from "./run-cards.js";

const TICK_MS = 3000;
const CLOCK_MS = 30000;

export class TreeBase {
  constructor(name) {
    this.name = name;
  }

  initBase(cx) {
    this.p = props() ?? {};
    this.preview = this.p.preview === true;
    this.width = 376;
    this.height = 800;
    this.ctxOpen = new Set();
    this.now = Date.now();
    if (this.preview || checking()) return;
    this.tick(cx, true);
    cx.timer.every(TICK_MS, (cx) => this.tick(cx, false));
    // Durations read in minutes: a redraw every half minute is enough.
    cx.timer.every(CLOCK_MS, (cx) => {
      if (!this.showsTree()) return;
      this.now = Date.now();
      cx.notify();
    });
  }

  /** The scans for what is seen: the forest, the selected node's detail, the shown run and its opened call. */
  tick(cx, force) {
    if (!this.showsTree()) return;
    refresh(cx, { force });
    const { scope, hide } = this.state();
    const sel = selection();
    if (sel?.id) ensureDetail(cx, find(sel.root, sel.id));
    if (this.inRun()) {
      const { root } = runRoot(scope);
      if (root) refreshRun(cx, root, { force });
      const c = openCall();
      // A call opened by a command carries no file: its card in the shown run has it.
      const file = c?.file ?? (root && c?.root === root.address ? runOf(root).data?.cards?.find((x) => x.id === c.card)?.file : null);
      if (file && c.row) ensureCall(cx, file, c.row);
    }
    // A failure drawn in a window in front counts as seen: the activity badge goes back to the running count.
    if (this.looking()) markSeen(this.inRun() ? drawnKeys(scope, hide) : new Set(rootsFor(scope).flatMap((r) => flatten(r, isOpen, hide)).map((n) => n.key)));
  }

  state() {
    return {
      scope: shared(TREE.scope) === "space" ? "space" : "focus",
      view: shared(TREE.view) === "run" ? "run" : "list",
      hide: Boolean(shared(TREE.hide)),
    };
  }

  /** Tracks the root's size in this.width / this.height. */
  sized(el) {
    return el.on_size_change((s, cx) => {
      if (Math.abs(s.width - this.width) > 1 || Math.abs(s.height - this.height) > 1) {
        this.width = s.width;
        this.height = s.height;
        cx.notify();
      }
    });
  }

  scopeControl() {
    const { scope } = this.state();
    const items = [
      { key: "focus", label: t("tree.scope.focus") },
      { key: "space", label: t("tree.scope.space") },
    ];
    return Segmented("tree-scope", items, scope, (v, cx) => {
      if (this.preview) return;
      setShared(TREE.scope, v);
      refresh(cx, { force: true });
      cx.notify();
    }, { label: t("tree.scope.label") });
  }

  hideControl() {
    const { hide } = this.state();
    return CheckBox("tree-hide", hide, (v, cx) => {
      if (this.preview) return;
      setShared(TREE.hide, Boolean(v));
      cx.notify();
    }, { label: t("tree.hideDone"), disabled: this.preview });
  }
}
