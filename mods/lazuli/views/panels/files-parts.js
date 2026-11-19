// Parts of the Files panel (views/files-tree.js): the delete confirm, the failed-operation notice, and the colors
// of git marks (DESIGN A3; behavior of lh-files.js `askNotice`).

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { t } from "../../core/i18n.js";
import { withAlpha } from "../../ui/tokens.js";
import { Text, Icon, Button, Banner } from "../../ui/kit.js";

/** A git mark's color: M working, U and A done (new), D and C error. */
export function markColor(mark, k) {
  if (mark === "M") return k.state.working;
  if (mark === "U" || mark === "A") return k.state.done;
  if (mark === "D" || mark === "C") return k.state.error;
  return k.text.tertiary;
}

const count = (n) => n.toLocaleString();

/** The delete confirm: what goes (a file, a folder with what it holds, a link alone, as the entry was when the
 *  confirm opened), where (the Trash, or gone for good), and two buttons: Cancel (also ⏎ and esc) and the delete
 *  itself, which removes only that same entry. */
export function DeleteConfirm(view, k) {
  const a = view.ask;
  const c = a.contents;
  const kind = a.ident.kind;
  const what = kind === "dir" ? "folder" : kind === "link" ? "link" : "file";
  const where = a.trash ? "trash" : "delete";
  const inside = kind === "link"
    ? (a.toFolder ? t("files.confirm.link") : null)
    : kind !== "dir"
      ? null
      : !c
        ? t(`files.confirm.uncounted.${where}`)
        : c.more
          ? t(`files.confirm.more.${where}`, { count: count(c.count) })
          : c.count
            ? t(`files.confirm.count.${where}`, { count: count(c.count) })
            : t("files.confirm.emptyFolder");
  const heavy = kind === "dir" && (!c || c.count > 0 || c.more);
  const danger = Button("files-ask-delete", a.busy ? t("files.confirm.busy") : t(`files.confirm.go.${where}`), {
    size: "sm",
    icon: "trash-2",
    disabled: a.busy,
    tooltip: t(`files.confirm.go.${where}`),
    onClick: (_e, cx) => view.confirmDelete(cx),
  });
  return div().flex_none().px(8).pb(8).child(
    v_flex()
      .id("files-ask")
      .gap(8)
      .p(12)
      .rounded(k.radius.md)
      .border_1()
      .border_color(withAlpha(k.state.error, 0.45))
      .bg(withAlpha(k.state.error, 0.08))
      .role("alert_dialog")
      .accessibility_label(t(`files.confirm.title.${where}.${what}`))
      .child(h_flex().gap(8).items_center().child(Icon("triangle-alert", { size: 15, color: k.state.error })).child(Text(t(`files.confirm.title.${where}.${what}`), { weight: "semibold" })))
      .when(Boolean(a.changed), (e) => e.child(Text(t("files.confirm.changed"), { size: "sm", tone: "warning", weight: "medium" })))
      .child(Text(kind === "dir" ? `${a.path}/` : a.path, { size: "sm", mono: true }))
      .when(Boolean(inside), (e) => e.child(Text(inside, { size: "sm", tone: heavy ? "error" : "secondary" })))
      .child(Text(t(a.trash ? "files.confirm.restorable" : a.on ? "files.confirm.remote" : "files.confirm.final", { machine: a.on ?? "" }), { size: "sm", tone: "secondary" }))
      .child(
        h_flex()
          .gap(8)
          .justify_end()
          .child(Button("files-ask-cancel", t("common.cancel"), { size: "sm", kbd: "esc", disabled: a.busy, tooltip: t("files.confirm.keep"), onClick: (_e, cx) => view.cancelDelete(cx) }))
          .child(a.busy ? danger : danger.text_color(k.state.error).border_color(withAlpha(k.state.error, 0.55))),
      ),
  );
}

/** Why the last operation failed, dismissable. */
export function FailedNotice(view) {
  return div().flex_none().px(8).pb(8).child(
    Banner({
      id: "files-failed",
      tone: "error",
      title: view.failed,
      onDismiss: (_e, cx) => {
        view.failed = null;
        cx.notify();
      },
      dismissLabel: t("common.close"),
    }),
  );
}
