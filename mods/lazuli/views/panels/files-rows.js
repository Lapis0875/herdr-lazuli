// The Files panel's rows (views/files-tree.js): folders and files depth-first under their open folders, with the
// chevron, the git mark (a dot on a folder holding changes), the eye of the space's preview tab, the actions shown
// while the pointer is on a row, and the name field where a new entry or a renamed one goes.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces } from "herdr";
import { t } from "../../core/i18n.js";
import { withAlpha } from "../../ui/tokens.js";
import { Text, Icon, IconButton, Row, TextInput } from "../../ui/kit.js";
import { registry } from "../../sys/filetabs.js";
import { TOTAL } from "../files-ops.js";
import { markColor } from "./files-parts.js";

const INDENT = 14;
const RANK = { C: 5, D: 4, M: 3, A: 2, U: 1 };

/** The folders holding changes, by relative path, each with its strongest mark. */
function folderMarks(view) {
  const cwd = view.context.cwd;
  const out = new Map();
  for (const [abs, mark] of Object.entries(view.marks)) {
    if (!abs.startsWith(`${cwd}/`)) continue;
    const parts = abs.slice(cwd.length + 1).split("/");
    for (let i = 1; i < parts.length; i++) {
      const p = parts.slice(0, i).join("/");
      if ((RANK[mark] ?? 0) > (RANK[out.get(p)] ?? 0)) out.set(p, mark);
    }
  }
  return out;
}

/** Files shown in the followed space's preview tab. */
function previewFiles(view) {
  // The registry keeps a closed tab's entry for two pruning ticks: only tabs still in spaces() count.
  const tabs = new Set((spaces() ?? []).flatMap((s) => (s.tabs ?? []).map((t) => t.id)));
  const out = new Set();
  for (const e of Object.values(registry())) {
    if (e?.preview === true && e.tab && tabs.has(e.tab) && e.space === view.space && (e.on ?? null) === (view.context?.on ?? null)) out.add(e.file);
  }
  return out;
}

/** The name field: a new entry's first row in its folder, or a renamed one's own row; why a name was refused below. */
function fieldRow(view, k, depth) {
  const e = view.edit;
  const icon = e.kind === "new" ? (e.dir ? "folder-plus" : "file-plus") : e.dir ? "folder" : "file-text";
  const verb = t(e.kind === "rename" ? "files.field.rename" : e.dir ? "files.field.mkdir" : "files.field.create");
  const hint = e.error ?? (e.busy ? t("files.field.busy") : t("files.field.hint", { verb }));
  return v_flex()
    .id("files-field")
    .flex_none()
    .py(3)
    .pl(8 + depth * INDENT + 19)
    .pr(4)
    .gap(3)
    .child(
      h_flex()
        .gap(4)
        .items_center()
        .child(Icon(icon, { size: 13, color: k.text.secondary }))
        .child(TextInput(view.input, { id: "files-name", focused: view.inputFocus.focused, invalid: Boolean(e.error), a11y: verb }).flex_1())
        .child(IconButton("files-field-ok", "check", verb, { disabled: e.busy, onClick: (_e, cx) => view.submit(cx) }))
        .child(IconButton("files-field-cancel", "x", t("common.cancel"), { disabled: e.busy, onClick: (_e, cx) => view.cancelEdit(cx) })),
    )
    .child(
      h_flex()
        .pl(17)
        .gap(4)
        .items_center()
        .when(Boolean(e.error), (x) => x.role("alert").child(Icon("circle-x", { size: 12, color: k.state.error })))
        .child(Text(hint, { size: "xs", tone: e.error ? "error" : "tertiary" })),
    );
}

/** A row's actions, each stopping its click there: Attach on a file of the Assistant's tree, new file and folder on a
 *  folder, then rename and delete. */
function rowActions(view, entry, path) {
  const act = (id, icon, label, fn) =>
    IconButton(id, icon, label, {
      iconSize: 13,
      onClick: (_e, cx) => {
        cx.stop_propagation();
        fn(cx);
        cx.notify();
      },
    }).size(20);
  return [
    ...(view.attachable(entry, path) ? [act(`files-attach-${path}`, "paperclip", t("assistant.files.attach"), () => view.attach(path))] : []),
    ...(entry.dir
      ? [act(`files-new-${path}`, "file-plus", t("files.newIn"), (cx) => view.startNew(path, cx)), act(`files-mkdir-${path}`, "folder-plus", t("files.mkdirIn"), (cx) => view.startNew(path, cx, true))]
      : []),
    act(`files-rename-${path}`, "pencil", t("files.rename"), (cx) => view.startRename(path, cx)),
    act(`files-delete-${path}`, "trash-2", t(entry.dir ? "files.deleteFolder" : "files.delete"), (cx) => view.startDelete(path, cx)),
  ];
}

function rows(view, k, prefix, depth, out, ctx) {
  if (out.length >= TOTAL || depth > 40) return out;
  const edit = view.edit;
  if (edit?.kind === "new" && edit.folder === prefix) out.push(fieldRow(view, k, depth));
  for (const entry of view.entries.get(prefix) ?? []) {
    if (out.length >= TOTAL) break;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    const abs = `${view.context.cwd}/${path}`;
    if (edit?.kind === "rename" && edit.path === path) {
      out.push(fieldRow(view, k, depth));
      // A folder being renamed keeps what is open under it in view.
      if (entry.dir && view.folders.has(path)) rows(view, k, path, depth + 1, out, ctx);
      continue;
    }
    const open = view.folders.has(path);
    const markOf = entry.dir ? ctx.folderMarks.get(path) ?? null : view.marks[abs] ?? null;
    const id = `files-row-${path}`;
    const asked = view.ask?.path === path;
    const trailing = [
      ...(!entry.dir && ctx.previews.has(abs) ? [div().id(`${id}-preview`).flex_none().tooltip(t("files.previewTab")).child(Icon("eye", { size: 13, color: k.text.tertiary }))] : []),
      ...(ctx.ops && (asked || view.hover === id) ? rowActions(view, entry, path) : []),
      ...(markOf
        ? [div().id(`${id}-mark`).w(12).flex_none().text_center().font_family(k.fonts.mono).text_size(k.fontSize.xs).text_color(markColor(markOf, k)).tooltip(t(`files.mark.${markOf}`)).child(entry.dir ? "•" : markOf)]
        : []),
    ];
    const chevron = h_flex()
      .w(14)
      .h(14)
      .flex_none()
      .items_center()
      .justify_center()
      .text_color(k.text.tertiary)
      .when(entry.dir, (e) => e.child(Icon(open ? "chevron-down" : "chevron-right", { size: 12 })));
    out.push(
      Row(id, {
        label: entry.name,
        leading: chevron,
        size: "sm",
        tone: "primary",
        indent: depth * INDENT,
        selected: !entry.dir && view.selected === abs,
        trailing,
        tooltip: asked || entry.name.length < 32 ? undefined : entry.name,
        onClick: (e, cx) => {
          if (entry.dir) view.toggle(path, cx);
          else view.openPath(path, (e?.click_count ?? 1) >= 2);
          cx.notify();
        },
      })
        .gap(5)
        .role("tree_item")
        .aria_level(depth + 1)
        .tab_index(0)
        .focus((s) => s.bg(k.bg.hover))
        .on_key_down((e, cx) => {
          if (e.keystroke !== "enter" && e.keystroke !== "space" && e.keystroke !== "cmd-enter") return;
          cx.stop_propagation();
          if (entry.dir) view.toggle(path, cx);
          else view.openPath(path, e.keystroke === "cmd-enter");
          cx.notify();
        })
        .when(asked, (e) => e.bg(withAlpha(k.state.error, 0.12)))
        .on_hover((hovered, cx) => {
          const next = hovered ? id : view.hover === id ? null : view.hover;
          if (next === view.hover) return;
          view.hover = next;
          cx.notify();
        }),
    );
    if (entry.dir && open) rows(view, k, path, depth + 1, out, ctx);
  }
  return out;
}

/** Every drawn row of the folder in view (at most TOTAL), depth-first. */
export function treeRows(view, k) {
  if (!view.context?.cwd) return [];
  const ctx = { folderMarks: folderMarks(view), previews: previewFiles(view), ops: view.ops() && !view.busy() };
  return rows(view, k, "", 0, [], ctx);
}
