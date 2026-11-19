// The run window (`view: "run"`, opened by ⤢ in the tree panel or `tree:window`;
// behavior of lstack-herdr's lh-tree-view.js (removed; git history ee5201a) component
// LhTreeWindow, new UI): the shown run as a top-down card tree, with the same scope, selection and opened call as
// the panel. Esc closes the opened call first, then the window.

import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, setShared } from "herdr";
import { t } from "../core/i18n.js";
import { tokens } from "../ui/tokens.js";
import { ViewRoot, Text, Icon, IconButton, Kbd, Divider, Spacer } from "../ui/kit.js";
import { openCall, setOpenCall, appActive } from "../sys/scan.js";
import { TreeBase } from "./panels/tree-base.js";
import { RunTree, runRoot } from "./panels/run-cards.js";
import { WINDOW_KEY } from "./panels/tree-actions.js";
import { stopPress } from "./panels/common.js";

export default class Run extends TreeBase {
  init(_props, cx) {
    this.initBase(cx);
    this.width = 1100;
    this.handle = cx.focus_handle();
    cx.timer.after(1, () => this.handle.focus());
  }

  focus() {
    this.handle.focus();
  }

  /** The window scans while it is open and always shows the run. */
  showsTree() {
    return true;
  }

  inRun() {
    return true;
  }

  looking() {
    return appActive();
  }

  close() {
    if (!this.preview && this.p.overlay) setShared(WINDOW_KEY, null);
  }

  shut() {
    if (this.preview || !this.p.overlay) return;
    setShared(WINDOW_KEY, null);
    closeOverlay(this.p.overlay);
  }

  render(_cx) {
    const k = tokens();
    const { scope, hide } = this.state();
    const { root } = runRoot(scope);
    const hint = (keys, what) => h_flex().flex_none().gap(6).items_center().child(Kbd(keys)).child(Text(what, { size: "xs", tone: "secondary", nowrap: true }));
    return this.sized(ViewRoot("run-window"))
      .track_focus(this.handle)
      .on_mouse_down("left", () => this.handle.focus())
      .on_key_down((e, cx) => {
        if (e.keystroke !== "escape") return;
        cx.stop_propagation();
        if (openCall() && !this.preview) {
          setOpenCall(null);
          cx.notify();
        } else this.shut();
      })
      .child(
        h_flex()
          .h(52)
          .flex_none()
          .px(20)
          .gap(10)
          .items_center()
          .border_b_1()
          .border_color(k.line.soft)
          .child(Icon("activity", { size: 16, color: k.accent }))
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .child(Text(t("tree.window.title"), { weight: "semibold", truncate: true }))
              .child(Text(root ? root.task : t("tree.run.none.title"), { size: "xs", tone: "secondary", truncate: true })),
          )
          .child(stopPress(this.scopeControl()))
          .child(stopPress(this.hideControl()))
          .child(Divider({ vertical: true, length: 24 }))
          .child(stopPress(IconButton("run-window-close", "x", t("common.close"), { tooltip: `${t("common.close")}  esc`, onClick: () => this.shut() }))),
      )
      .child(stopPress(v_flex().flex_1().min_h(0).child(RunTree({ scope, hide, width: this.width, preview: this.preview }))))
      .child(
        h_flex()
          .h(36)
          .flex_none()
          .px(24)
          .gap(14)
          .items_center()
          .border_t_1()
          .border_color(k.line.soft)
          .child(hint("esc", t("tree.window.hint.esc")))
          .child(hint("tab", t("tree.window.hint.tab")))
          .child(hint("↵", t("tree.window.hint.enter")))
          .child(Spacer())
          .child(Text(t("tree.window.hint.shared"), { size: "xs", tone: "tertiary", truncate: true })),
      );
  }
}
