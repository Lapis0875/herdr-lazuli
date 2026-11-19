// An HTML tab's preview when no browser the viewer can drive is installed (DESIGN B8): Herdr's static
// `TextView.html` render (no CSS, no scripts) of the saved file, as the model last loaded or saved it
// (B7: the preview shows the saved file only, never unsaved edits), and "Open in browser" on it.

import { h_flex, v_flex, TextView } from "gpui-base";
import { t } from "../core/i18n.js";
import { tokens } from "../ui/tokens.js";
import { Button, Icon, Text } from "../ui/kit.js";

export class HtmlFallback {
  constructor(model) {
    this.model = model;
    this.opening = false;
  }

  open(cx) {
    if (this.opening) return;
    this.opening = true;
    cx.spawn(async (cx) => {
      await this.model.openExternal();
      this.opening = false;
      cx.notify();
    });
  }

  render(_cx) {
    const k = tokens();
    // `original`: the text of the last load, reload or successful save.
    const text = this.model.original ?? "";
    return v_flex()
      .id("html-fallback")
      .size_full()
      .min_w(0)
      .min_h(0)
      .bg(k.bg.card)
      .child(
        h_flex()
          .flex_none()
          .min_h(34)
          .px(12)
          .py(4)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(k.line.soft)
          .bg(k.bg.surface)
          .role("status")
          .child(Icon("info", { size: 14, color: k.text.tertiary }))
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .child(Text(t("filetab.viewer.no-browser"), { size: "sm", tone: "secondary" }))
              .child(Text(t("filetab.html.fallback-body"), { size: "xs", tone: "tertiary" })),
          )
          .child(
            Button("html-open-browser", t("filetab.html.open-browser"), {
              size: "sm",
              icon: "external",
              disabled: this.opening,
              onClick: (_e, cx) => this.open(cx),
            }),
          ),
      )
      .child(
        v_flex()
          .id("html-fallback-body")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .px(24)
          .py(18)
          .text_color(k.text.primary)
          .child(TextView.html("html-fallback-view", text).selectable(true)),
      );
  }
}
