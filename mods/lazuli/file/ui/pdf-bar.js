// The PDF view's chrome (DESIGN B9): the toolbar (outline toggle, page indicator and jump, zoom steps,
// search with next and previous, "Copy page text", "Open in Preview"), the outline panel, and the
// screen shown until pages can be drawn (preparing the renderer, opening, or failed with Retry and
// "Open in Preview"). Drawn from a PdfView's state; every action goes back to the view.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { t } from "../../core/i18n.js";
import { pdfdState } from "../../sys/sidecars.js";
import { Badge, Button, Divider, Empty, IconButton, Row, Spacer, Spinner, Text, TextInput } from "../../ui/kit.js";

/** Below this width the toolbar drops its text labels. */
const NARROW = 620;

/** Message key for a PdfClient error code. */
export function pdfErrorKey(code) {
  return ["encrypted", "not_found", "render_failed", "daemon-lost", "unavailable"].includes(code) ? `filetab.pdf.error.${code}` : "filetab.pdf.error.other";
}

/** The screen before pages show: "Preparing PDF renderer" while pdfd builds, opening, or failed. */
export function pdfStatus(v, k) {
  const p = v.pdf;
  const root = v_flex().id("pdf-status").size_full().items_center().justify_center().p(24).bg(k.bg.card);
  if (p.state !== "failed") {
    const building = pdfdState().state === "building";
    return root
      .gap(10)
      .role("status")
      .child(Spinner({ size: 18 }))
      .child(Text(t(building ? "filetab.pdf.preparing" : "filetab.pdf.opening"), { size: "sm", tone: "secondary" }));
  }
  const unavailable = p.mode === "preview" || p.error === "unavailable";
  const encrypted = p.error === "encrypted";
  const actions = h_flex()
    .gap(8)
    .child(Button("pdf-open-preview", t("filetab.pdf.open-preview"), { variant: "primary", icon: "external", onClick: (_e, cx) => v.openPreview(cx) }))
    .child(
      Button("pdf-retry", t("common.retry"), {
        icon: "refresh-cw",
        onClick: (_e, cx) => {
          p.retry();
          cx.notify();
        },
      }),
    );
  let body = t(pdfErrorKey(p.error), { code: p.error ?? "" });
  if (unavailable) body = t("filetab.pdf.unavailable-body");
  else if (encrypted) body = t("filetab.pdf.encrypted-body");
  return root.child(
    Empty({
      id: "pdf-failed",
      icon: unavailable ? "file" : "triangle-alert",
      title: t(unavailable ? "filetab.pdf.unavailable" : encrypted ? "filetab.pdf.error.encrypted" : "filetab.pdf.failed"),
      body,
      action: actions,
    }),
  );
}

function pageIndicator(v, l, k) {
  const pages = v.pdf.info.pages;
  const current = v.currentPage(l);
  if (v.editingPage) {
    return h_flex()
      .flex_none()
      .gap(6)
      .items_center()
      .child(TextInput(v.pageInput, { id: "pdf-page-input", focused: true, mono: true, a11y: t("filetab.pdf.page-jump") }).w(64))
      .child(Text(`/ ${pages}`, { size: "sm", tone: "tertiary", mono: true, nowrap: true }));
  }
  return Button("pdf-page", t("filetab.pdf.page-of", { page: current, pages }), {
    variant: "ghost",
    size: "sm",
    tooltip: t("filetab.pdf.page-jump"),
    a11y: `${t("filetab.pdf.page-jump")}: ${t("filetab.pdf.page-of", { page: current, pages })}`,
    onClick: (_e, cx) => v.editPage(cx),
  }).font_family(k.fonts.mono).min_w(64).justify_center();
}

function zoomGroup(v, l) {
  const fit = v.zoom === "fit";
  const label = fit ? t("filetab.zoom.fit-width") : `${v.zoom}%`;
  return h_flex()
    .flex_none()
    .gap(2)
    .items_center()
    .child(IconButton("pdf-zoom-out", "zoom-out", t("filetab.zoom.out"), { onClick: (_e, cx) => v.zoomStep(-1, cx) }))
    .child(
      Button("pdf-zoom", label, {
        variant: "ghost",
        size: "sm",
        icon: fit ? "move-horizontal" : undefined,
        tooltip: t(fit ? "filetab.zoom.actual" : "filetab.zoom.fit-width"),
        a11y: `${t("filetab.zoom.label")}: ${fit ? label : `${v.percent(l)}%`}`,
        onClick: (_e, cx) => v.setZoom(fit ? 100 : "fit", cx),
      })
        .min_w(56)
        .justify_center(),
    )
    .child(IconButton("pdf-zoom-in", "zoom-in", t("filetab.zoom.in"), { onClick: (_e, cx) => v.zoomStep(1, cx) }));
}

function searchGroup(v, narrow) {
  const s = v.search;
  let count = null;
  if (s.busy) count = Spinner({ size: 13, label: t("filetab.pdf.search-busy") });
  else if (s.error) count = Text(t("filetab.pdf.search-failed"), { size: "xs", tone: "error", nowrap: true });
  else if (s.query && !s.hits.length) count = Text(t("filetab.pdf.search-none"), { size: "xs", tone: "tertiary", nowrap: true });
  else if (s.hits.length) {
    const key = s.truncated ? "filetab.pdf.search-many" : "filetab.pdf.search-count";
    count = Text(t(key, { current: s.index + 1, total: s.hits.length }), { size: "xs", tone: "secondary", mono: true, nowrap: true });
  }
  const none = !s.hits.length;
  return h_flex()
    .flex_none()
    .gap(4)
    .items_center()
    .child(TextInput(v.searchInput, { id: "pdf-search", icon: "search", a11y: t("filetab.pdf.search-placeholder") }).w(narrow ? 140 : 200).h(26))
    .when(Boolean(count), (e) => e.child(count))
    .child(IconButton("pdf-hit-prev", "chevron-up", t("filetab.pdf.search-prev"), { disabled: none, onClick: (_e, cx) => v.moveHit(-1, cx) }))
    .child(IconButton("pdf-hit-next", "chevron-down", t("filetab.pdf.search-next"), { disabled: none, onClick: (_e, cx) => v.moveHit(1, cx) }));
}

function copyGroup(v, narrow) {
  const c = v.copy;
  const note = c
    ? {
        busy: null,
        done: Text(t("filetab.pdf.copied", { page: c.page }), { size: "xs", tone: "success", nowrap: true }),
        empty: Text(t("filetab.pdf.copy-empty", { page: c.page }), { size: "xs", tone: "tertiary", nowrap: true }),
        failed: Text(t("filetab.pdf.copy-failed"), { size: "xs", tone: "error", nowrap: true }),
      }[c.state]
    : null;
  const busy = c?.state === "busy";
  const control = narrow
    ? IconButton("pdf-copy", "copy", t("filetab.pdf.copy-text"), { disabled: busy, onClick: (_e, cx) => v.copyText(cx) })
    : Button("pdf-copy", t("filetab.pdf.copy-text"), { variant: "ghost", size: "sm", icon: "copy", disabled: busy, onClick: (_e, cx) => v.copyText(cx) });
  return h_flex()
    .flex_none()
    .gap(6)
    .items_center()
    .when(Boolean(note), (e) => e.child(div().role("status").child(note)))
    .child(control);
}

/** The toolbar row. `l` is the view's layout (null before the first size). */
export function pdfToolbar(v, l, k) {
  const narrow = v.view.width > 0 && v.view.width < NARROW;
  const full = v.full;
  const info = v.pdf.info;
  return h_flex()
    .id("pdf-toolbar")
    .flex_none()
    .h(38)
    .px(8)
    .gap(4)
    .items_center()
    .border_b(1)
    .border_color(k.line.soft)
    .when(full, (e) =>
      e.child(
        IconButton("pdf-outline", "panel-left", t(info.hasOutline ? "filetab.pdf.outline-show" : "filetab.pdf.outline-empty"), {
          selected: v.outlineOpen,
          disabled: !info.hasOutline,
          onClick: (_e, cx) => v.toggleOutline(cx),
        }),
      ),
    )
    .child(pageIndicator(v, l, k))
    .child(Divider({ vertical: true, length: 16 }).mx(4))
    .child(zoomGroup(v, l))
    .child(Spacer())
    .when(!full, (e) => e.child(div().tooltip(t("filetab.pdf.limited")).child(Badge(t("filetab.pdf.basic"), { tone: "default" }))))
    .when(full, (e) => e.child(searchGroup(v, narrow)))
    .child(Divider({ vertical: true, length: 16 }).mx(4))
    .child(copyGroup(v, narrow))
    .child(IconButton("pdf-open-preview-bar", "external", t("filetab.pdf.open-preview"), { onClick: (_e, cx) => v.openPreview(cx) }));
}

/** The outline side panel. */
export function outlinePanel(v, l, k) {
  const o = v.outline;
  const current = v.currentPage(l);
  let body;
  if (!o || o.busy) {
    body = h_flex().p(12).gap(8).items_center().child(Spinner({ size: 13 })).child(Text(t("filetab.pdf.outline-loading"), { size: "sm", tone: "tertiary" }));
  } else if (o.error) {
    body = Empty({ id: "pdf-outline-error", icon: "triangle-alert", title: t("filetab.pdf.outline-failed") });
  } else if (!o.items.length) {
    body = Empty({ id: "pdf-outline-empty", icon: "list", title: t("filetab.pdf.outline-empty") });
  } else {
    // The entry for the page read now: the last one at or before it.
    let mark = -1;
    o.items.forEach((item, i) => {
      if (Number.isInteger(item.page) && item.page <= current) mark = i;
    });
    body = v_flex()
      .id("pdf-outline-list")
      .flex_1()
      .min_h(0)
      .overflow_y_scrollbar()
      .p(4)
      .gap(1)
      .children(
        o.items.map((item, i) =>
          Row(`pdf-outline-${i}`, {
            label: String(item.title ?? ""),
            detail: Number.isInteger(item.page) ? String(item.page) : null,
            indent: Math.min(6, Math.max(0, item.depth ?? 0)) * 12,
            size: "sm",
            current: i === mark,
            tooltip: String(item.title ?? ""),
            onClick: (_e, cx) => Number.isInteger(item.page) && v.scrollToPage(item.page, cx),
          }),
        ),
      );
  }
  return v_flex()
    .id("pdf-outline")
    .w(240)
    .flex_none()
    .min_h(0)
    .border_r(1)
    .border_color(k.line.soft)
    .bg(k.bg.card)
    .role("navigation")
    .accessibility_label(t("filetab.pdf.outline"))
    .child(h_flex().h(32).px(12).flex_none().items_center().child(Text(t("filetab.pdf.outline"), { size: "sm", weight: "semibold" })))
    .child(body);
}
