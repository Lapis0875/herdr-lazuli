// A file tab's header row and message banners (DESIGN B2–B7, mockup A file-*.png). The header is drawn
// from a plain, serializable state (headStateOf), so another copy can draw it too: inside the lazuli
// layout the pane header (views/pane-head.js) draws it through file/ui/head.js. It shows the path as a
// breadcrumb with the unsaved dot, the machine of a remote file, the preview-tab chip (click pins it),
// the save state (unsaved and its draft, saving, or why the file is read-only), the viewer's progress,
// the Edit / Split / Preview control, and "View in Chrome" for Markdown. The banners stay in the tab:
// the recovered draft (Restore / Discard), the disk conflict (Reload / Overwrite, or Save again when
// deleted) and a failed save.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { home } from "herdr";
import { t } from "../../core/i18n.js";
import { basename, dirname, kindOf, tilde } from "../../core/paths.js";
import { tokens } from "../../ui/tokens.js";
import { Banner, Chip, Icon, IconButton, Segmented, Spinner, Text } from "../../ui/kit.js";

/** Below this width the header keeps only the dot of the save state. */
const NARROW = 560;

const KIND_ICON = { md: "file-text", html: "file-code", svg: "image", image: "image", pdf: "file", text: "file-code", binary: "file" };
const MODE_ICON = { edit: "pencil", split: "square-split", preview: "eye" };

/** The viewer pane's progress (HTML, Markdown in Chrome) as a catalog key, or null. */
function viewerBusy(m, v) {
  if (!v || v.fallback || v.want === "none" || v.have === "unknown") return null;
  if (m.browser === null) return "filetab.viewer.checking";
  return v.have !== v.want ? "filetab.viewer.starting" : null;
}

/** A FileModel's header as plain data (JSON-safe, published for the pane header).
 *  `o`: {mode (the mode shown), viewer (the tab's viewer state or null)}.
 *  `{fid, path, on, kind, status, preview, dirty, save: "unsaved"|"saving"|"readonly"|null, draft,
 *  reason, mode, modes, chrome: null | {open, available}, busy (a catalog key or null)}`. */
export function headStateOf(m, o = {}) {
  const ready = m.status === "ready";
  const text = ready && m.kind !== "pdf" && m.kind !== "image";
  let save = null;
  if (text && m.readOnly && m.reason) save = "readonly";
  else if (text && m.saving) save = "saving";
  else if (text && m.dirty) save = "unsaved";
  return {
    fid: m.fid,
    path: m.file,
    on: m.on || null,
    kind: m.kind,
    status: m.status,
    preview: m.preview === true,
    dirty: m.dirty === true,
    save,
    draft: save === "unsaved" && m.draftOnDisk === true,
    reason: save === "readonly" ? m.reason : null,
    mode: ready ? (o.mode ?? m.mode ?? null) : null,
    modes: ready && m.modes.length > 1 && !m.kindPending ? [...m.modes] : [],
    chrome: ready && m.kind === "md" && !m.on && !m.kindPending ? { open: m.chrome === true, available: m.browser !== false } : null,
    busy: viewerBusy(m, o.viewer ?? null),
    // What the viewer pane should show ("none" | "split" | "zoomed"), so the pane header can compare
    // it with the panes live while this tab is hidden behind a zoomed viewer.
    viewerWant: o.viewer && !o.viewer.fallback ? o.viewer.want : null,
  };
}

function crumb(s, k) {
  const parts = tilde(dirname(s.path), home()).split("/").filter(Boolean);
  const shown = parts.slice(-2);
  const children = [Icon(KIND_ICON[s.kind] ?? "file", { size: 13, color: k.text.tertiary })];
  if (parts.length > shown.length) children.push(Text("…", { tone: "tertiary" }));
  for (const p of shown) {
    children.push(Text(p, { tone: "secondary", nowrap: true }).flex_shrink(1).min_w(0).truncate());
    children.push(Text("/", { tone: "tertiary" }).flex_none());
  }
  children.push(Text(basename(s.path) || s.path, { weight: "medium", nowrap: true }).flex_none());
  if (s.dirty) children.push(div().flex_none().size(7).rounded(k.radius.full).bg(k.state.blocked).accessibility_label(t("filetab.save.unsaved")));
  return h_flex()
    .id("file-crumb")
    .flex_1()
    .min_w(0)
    .gap(6)
    .items_center()
    .overflow_hidden()
    .tooltip(s.on ? `${s.on}:${s.path}` : tilde(s.path, home()))
    .children(children);
}

function saveState(s, k, narrow) {
  if (s.save === "readonly") {
    const why = t(`filetab.readonly.${s.reason}`);
    return h_flex()
      .flex_none()
      .gap(5)
      .items_center()
      .text_color(k.text.tertiary)
      .tooltip(why)
      .child(Icon("lock", { size: 12 }))
      .when(!narrow, (e) => e.child(Text(why, { size: "sm", tone: "tertiary", nowrap: true })));
  }
  if (s.save === "saving") {
    return h_flex().flex_none().gap(6).items_center().role("status").child(Spinner({ size: 12 })).child(Text(t("filetab.save.saving"), { size: "sm", tone: "tertiary", nowrap: true }));
  }
  if (s.save !== "unsaved" || narrow) return null;
  return h_flex()
    .flex_none()
    .gap(6)
    .items_center()
    .tooltip(t("filetab.save.hint"))
    .child(Text(t("filetab.save.unsaved"), { size: "sm", tone: "blocked", weight: "medium", nowrap: true }))
    .when(s.draft, (e) => e.child(Text(`· ${t("filetab.save.draft")}`, { size: "sm", tone: "tertiary", nowrap: true })));
}

/** A viewer pane's header (the state from fileHeadFor with `viewerPane`): what it shows and, while it
 *  starts, the progress. While the viewer is zoomed over the tab (HTML Preview: no other header
 *  shows) the Edit / Split / Preview switch follows, so there is a way back on screen; in Split the
 *  file's own pane carries it. */
function viewerLine(s, o, k) {
  const name = basename(s.path) || s.path;
  const items = s.kind === "html" && s.viewerZoomed && o.onMode ? (s.modes ?? []).map((key) => ({ key, label: t(`filetab.mode.${key}`), icon: MODE_ICON[key] })) : [];
  const row = h_flex().id("file-viewer-head").flex_none().min_w(0).gap(8).items_center();
  return (o.compact ? row.size_full().pl(10).pr(4) : row.w_full().h(40).pl(12).pr(8).border_b(1).border_color(k.line.soft))
    .font_family(k.fonts.ui)
    .text_size(k.fontSize.md)
    .text_color(k.text.secondary)
    .tooltip(s.on ? `${s.on}:${s.path}` : tilde(s.path, home()))
    .child(Icon("globe", { size: 13, color: k.text.tertiary }))
    .child(Text(t("filetab.viewer.pane", { name }), { size: "sm", tone: "secondary", truncate: true }).flex_1())
    .when(Boolean(s.busy), (e) => e.child(Spinner({ size: 12, label: t(s.busy) })))
    .when(items.length > 1, (e) => e.child(Segmented("file-mode", items, s.mode, (key, cx) => o.onMode(key, cx), { label: t("filetab.mode.label") })));
}

/** The header row from a headStateOf() state. Pure: safe in any copy's render.
 *  `o`: {width (px; below 560 it keeps only the unsaved dot), compact (fills a pane header: its
 *  height, no rule below), onMode(mode, cx), onPin(cx), onChrome(cx)}. A missing handler hides its
 *  control. A viewer pane's state (`viewerPane`) draws only the plain "Chrome view of" line. */
export function fileHeader(s, o = {}) {
  const k = tokens();
  if (s.viewerPane) return viewerLine(s, o, k);
  const narrow = o.width > 0 && o.width < NARROW;
  const items = (s.modes ?? []).map((key) => ({ key, label: t(`filetab.mode.${key}`), icon: MODE_ICON[key] }));
  const save = saveState(s, k, narrow);
  const row = h_flex().id("file-head").flex_none().min_w(0).gap(10).items_center();
  return (o.compact ? row.size_full().pl(10).pr(4) : row.w_full().h(40).pl(12).pr(8).border_b(1).border_color(k.line.soft))
    .font_family(k.fonts.ui)
    .text_size(k.fontSize.md)
    .text_color(k.text.primary)
    .child(crumb(s, k))
    .when(Boolean(s.on), (e) => e.child(Chip(s.on, { icon: "server", mono: true, tooltip: t("filetab.remote", { machine: s.on }) })))
    .when(s.preview, (e) =>
      e.child(
        Chip(t("filetab.tab.preview"), {
          id: "file-pin",
          icon: "pin",
          tooltip: t("filetab.tab.pin"),
          onClick: o.onPin ? (_e, cx) => o.onPin(cx) : undefined,
        }),
      ),
    )
    .when(Boolean(save), (e) => e.child(save))
    .when(Boolean(s.busy), (e) =>
      e.child(
        h_flex()
          .flex_none()
          .gap(6)
          .items_center()
          .role("status")
          .child(Spinner({ size: 12 }))
          .when(!narrow, (x) => x.child(Text(t(s.busy), { size: "sm", tone: "tertiary", nowrap: true }))),
      ),
    )
    .when(items.length > 0 && Boolean(o.onMode), (e) =>
      e.child(Segmented("file-mode", items, s.mode, (key, cx) => o.onMode(key, cx), { label: t("filetab.mode.label") })),
    )
    .when(Boolean(s.chrome) && Boolean(o.onChrome), (e) =>
      e.child(
        IconButton("file-chrome", "external", t(!s.chrome.available ? "filetab.viewer.no-browser" : s.chrome.open ? "filetab.chrome.close" : "filetab.chrome.open"), {
          selected: s.chrome.open,
          disabled: !s.chrome.available,
          onClick: (_e, cx) => o.onChrome(cx),
        }),
      ),
    );
}

/** The banners under the header, or an empty list. */
export function fileBanners(m) {
  const out = [];
  if (m.kindPending) {
    // Renamed to a picture or PDF while unsaved: it stays text until saved or its edits are undone.
    const kind = kindOf(m.file) === "pdf" ? "pdf" : "image";
    out.push(
      Banner({
        id: "file-kind-pending",
        tone: "info",
        icon: kind === "pdf" ? "file" : "image",
        title: t(`filetab.pending.${kind}`),
        actions: m.editable && !m.saving ? [{ id: "file-kind-save", label: t("common.save"), kbd: "⌘S", onClick: (_e, cx) => m.save(cx) }] : [],
      }),
    );
  }
  // The Chrome viewer (Markdown "View in Chrome", an HTML tab's Split/Preview) shows the saved file
  // only (B6, B7); the tab's own Markdown preview follows the editor.
  const viewer = !m.on && m.status === "ready" && m.browser !== false && (m.kind === "md" ? m.chrome : m.kind === "html" && m.mode !== "edit");
  if (viewer && m.dirty && !m.kindPending) {
    const k = tokens();
    out.push(
      h_flex()
        .id("file-chrome-saved")
        .gap(6)
        .items_center()
        .role("status")
        .child(Icon("info", { size: 13, color: k.text.tertiary }))
        .child(Text(t("filetab.chrome.saved-only"), { size: "sm", tone: "tertiary" })),
    );
  }
  if (m.draft) {
    // A file deleted on disk keeps its draft: restoring it and saving makes the file again.
    let title = m.draft.baseChanged ? "filetab.draft.base-changed" : "filetab.draft.recovered";
    if (m.status === "missing") title = "filetab.draft.deleted";
    out.push(
      Banner({
        id: "file-draft",
        tone: "info",
        icon: "history",
        title: t(title),
        actions: [
          { id: "file-draft-restore", label: t("filetab.draft.restore"), variant: "primary", onClick: (_e, cx) => m.restoreDraft(cx) },
          { id: "file-draft-discard", label: t("filetab.draft.discard"), onClick: (_e, cx) => m.discardDraft(cx) },
        ],
      }),
    );
  }
  if (m.draftError === "not-replaced") {
    // The draft file could not be rewritten; the next tick tries again (model.js).
    const k = tokens();
    out.push(
      h_flex()
        .id("file-draft-error")
        .gap(6)
        .items_center()
        .role("alert")
        .child(Icon("triangle-alert", { size: 13, color: k.state.warning }))
        .child(Text(t("filetab.draft.not-replaced"), { size: "sm", tone: "secondary" })),
    );
  }
  if (m.conflict) {
    const deleted = typeof m.conflict.disk !== "string";
    let title = deleted ? "filetab.conflict.deleted" : "filetab.conflict.changed";
    if (m.conflict.binary) title = "filetab.conflict.binary";
    out.push(
      Banner({
        id: "file-conflict",
        tone: "warning",
        title: t(title),
        body: t(deleted ? "filetab.conflict.deleted-body" : "filetab.conflict.body"),
        actions: deleted
          ? [{ id: "file-conflict-save", label: t("filetab.conflict.save-again"), variant: "primary", onClick: (_e, cx) => m.overwrite(cx) }]
          : [
              { id: "file-conflict-reload", label: t("filetab.conflict.reload"), onClick: (_e, cx) => m.reload(cx) },
              // A file that is no longer text is not written over: the edits go to a copy beside it.
              m.conflict.binary
                ? { id: "file-conflict-copy", label: t("filetab.conflict.save-copy"), variant: "primary", onClick: (_e, cx) => m.saveCopy(cx) }
                : { id: "file-conflict-overwrite", label: t("filetab.conflict.overwrite"), variant: "primary", onClick: (_e, cx) => m.overwrite(cx) },
            ],
      }),
    );
  }
  if (m.copiedTo) {
    const k = tokens();
    out.push(
      h_flex()
        .id("file-copied")
        .gap(6)
        .items_center()
        .min_w(0)
        .role("status")
        .child(Icon("circle-check", { size: 13, color: k.state.success }))
        .child(Text(t("filetab.conflict.copied", { path: tilde(m.copiedTo, home()) }), { size: "sm", tone: "secondary", truncate: true }).flex_1()),
    );
  }
  if (m.failed) {
    out.push(
      Banner({
        id: "file-save-failed",
        tone: "error",
        title: t("filetab.save.failed", { detail: m.failed }),
        // A failed copy (binary conflict) is retried as a copy; a plain save as a save.
        actions: [{ id: "file-save-retry", label: t("common.retry"), onClick: (_e, cx) => (m.conflict?.binary ? m.saveCopy(cx) : m.save(cx)) }],
      }),
    );
  }
  return out.length ? [v_flex().flex_none().px(10).pt(8).gap(6).children(out)] : [];
}
