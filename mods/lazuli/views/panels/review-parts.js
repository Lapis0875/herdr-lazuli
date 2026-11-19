// Parts of the Review panel's diff mode (views/review.js): the summary bar (file count, lines added and removed,
// the file list, side by side and fold-all toggles) and the changed-file list.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { t } from "../../core/i18n.js";
import { Text, IconButton, Row, Spacer } from "../../ui/kit.js";

const mono = (k, s, color) => div().flex_none().font_family(k.fonts.mono).text_size(k.fontSize.xs).text_color(color).whitespace_nowrap().child(s);

/** The bar above the diff. `view` is the Review view. */
export function Summary(view, k, r) {
  const m = r.model;
  return h_flex()
    .h(32)
    .flex_none()
    .pl(12)
    .pr(6)
    .gap(8)
    .items_center()
    .child(Text(t("review.files.count", { count: m.files.length }), { size: "xs", tone: "secondary", nowrap: true }))
    .child(mono(k, `+${m.added}`, k.diff.add))
    .child(mono(k, `−${m.removed}`, k.diff.remove))
    .child(Spacer())
    .child(IconButton("review-files", "files", t("review.files.toggle"), { selected: view.filesOpen, onClick: (_e, cx) => { view.filesOpen = !view.filesOpen; cx.notify(); } }))
    .child(IconButton("review-split", "columns", t("review.split"), { selected: view.diff.split, onClick: (_e, cx) => { view.diff.split = !view.diff.split; cx.notify(); } }))
    .child(IconButton("review-fold", "chevrons-down-up", t("review.foldAll"), { onClick: (_e, cx) => { view.diff.foldAll(); cx.notify(); } }));
}

/** The changed files; a click puts that file's header at the top of the diff. */
export function FileList(view, k, r) {
  return v_flex()
    .id("review-file-list")
    .flex_none()
    .max_h(172)
    .px(6)
    .pb(6)
    .overflow_y_scrollbar()
    .border_b_1()
    .border_color(k.line.soft)
    .role("list")
    .accessibility_label(t("review.files.toggle"))
    .children(
      r.model.files.map((f, i) =>
        Row(`review-file-${i}`, {
          label: f.path,
          mono: true,
          size: "sm",
          tone: "primary",
          current: view.diff.cursor?.f === i,
          tooltip: f.path,
          trailing: [mono(k, `+${f.added}`, k.diff.add), mono(k, `−${f.removed}`, k.diff.remove)],
          onClick: (_e, cx) => {
            view.diff.jumpTo(i);
            cx.notify();
          },
        }),
      ),
    );
}
