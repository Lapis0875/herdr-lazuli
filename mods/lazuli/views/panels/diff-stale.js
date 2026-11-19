// The Review diff's stale comments (views/diff.js): comments whose line the agent changed or removed since they were
// written. They are listed above the diff with the code they quoted, are not sent, and wait for the reviewer to move
// each one to the line it is about now (pick a line: click it, or j/k then ⏎) or to delete it.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { t } from "../../core/i18n.js";
import { withAlpha } from "../../ui/tokens.js";
import { Text, Icon, Button, Kbd } from "../../ui/kit.js";

/** The strip above the diff; `view` is the DiffView. */
export function StaleStrip(view, k) {
  const stale = view.stale();
  const picking = view.anchoring ? stale.find((c) => c.id === view.anchoring) : null;
  const item = (c) => {
    const on = c.id === view.anchoring;
    return h_flex()
      .id(`${view.id}-stale-${c.id}`)
      .gap(8)
      .px(8)
      .py(6)
      .items_start()
      .rounded(k.radius.md)
      .bg(on ? withAlpha(k.accent, 0.1) : k.bg.card)
      .border_1()
      .border_color(on ? k.accent : k.line.soft)
      .role("list_item")
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .gap(2)
          .child(Text(`${c.path}:${c.line}${c.old ? t("review.message.removed") : ""}`, { size: "xs", tone: "secondary", mono: true, truncate: true }))
          .child(Text(String(c.code ?? "").trim() || " ", { size: "xs", tone: "tertiary", mono: true, truncate: true }))
          .child(Text(c.text, { size: "sm" })),
      )
      .child(
        Button(`${view.id}-stale-move-${c.id}`, t("review.stale.move"), {
          size: "sm",
          variant: on ? "primary" : "secondary",
          tooltip: t("review.stale.moveHint"),
          onClick: (_e, cx) => {
            view.composer = null;
            view.anchoring = on ? null : c.id;
            cx.notify();
          },
        }),
      )
      .child(
        Button(`${view.id}-stale-del-${c.id}`, t("common.delete"), {
          size: "sm",
          variant: "ghost",
          onClick: (_e, cx) => {
            view.remove(c.id);
            cx.notify();
          },
        }),
      );
  };
  return v_flex()
    .id(`${view.id}-stale`)
    .flex_none()
    .mx(8)
    .mb(6)
    .p(8)
    .gap(6)
    .rounded(k.radius.md)
    .bg(withAlpha(k.state.warning, 0.08))
    .border_1()
    .border_color(withAlpha(k.state.warning, 0.4))
    .role("alert")
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .child(
      h_flex()
        .gap(6)
        .items_center()
        .child(Icon("triangle-alert", { size: 14, color: k.state.warning }))
        .child(Text(t("review.stale.title", { count: stale.length }), { size: "sm", weight: "semibold", truncate: true }).flex_1()),
    )
    .child(
      picking
        ? h_flex()
            .gap(6)
            .items_center()
            .flex_wrap()
            .child(Text(t("review.stale.picking"), { size: "xs", tone: "accent", weight: "medium" }))
            .child(Kbd("⏎"))
            .child(Kbd("esc"))
        : Text(t("review.stale.body"), { size: "xs", tone: "secondary" }),
    )
    .child(div().id(`${view.id}-stale-list`).max_h(168).overflow_y_scrollbar().child(v_flex().gap(4).role("list").children(stale.map(item))));
}
