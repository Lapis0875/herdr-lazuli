// The card a file tab shows instead of a view (DESIGN B3, B10): a binary or undecodable file, or a PDF
// or picture on a remote machine. Name, size, type as `file` reports it, and "Open in default app" for
// files on this Mac.

import { h_flex, v_flex } from "gpui-base";
import { t } from "../core/i18n.js";
import { tokens } from "../ui/tokens.js";
import { Button, Card, Icon, Text } from "../ui/kit.js";

/** 1234567 → "1,234,567" (QuickJS has no Intl). */
export function grouped(n) {
  return String(Math.trunc(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** A byte count in the largest unit that keeps it ≥ 1: "812 B", "1.2 MB". */
export function humanSize(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return u === 0 ? `${v} B` : `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[u]}`;
}

export class InfoCard {
  constructor(model) {
    this.model = model;
    this.opening = false;
    this.failed = false;
  }

  openExternal(cx) {
    if (this.opening) return;
    this.opening = true;
    this.failed = false;
    cx.notify();
    cx.spawn(async (cx) => {
      const ok = await this.model.openExternal();
      this.opening = false;
      this.failed = !ok;
      cx.notify();
    });
  }

  render(_cx, { title, icon = "file" } = {}) {
    const k = tokens();
    const m = this.model;
    const info = m.info ?? {};
    const row = (label, value, mono = false) =>
      h_flex()
        .w_full()
        .min_w(0)
        .gap(12)
        .items_start()
        .child(Text(label, { size: "sm", tone: "tertiary", nowrap: true }).w(64).flex_none())
        .child(Text(value, { size: "sm", tone: "primary", mono }).flex_1().min_w(0));
    const size = typeof info.size === "number" ? `${humanSize(info.size)} · ${t("filetab.info.size", { size: grouped(info.size) })}` : t("filetab.info.unknown");
    const where = m.on ? `${m.on}:${m.file}` : m.file;
    const card = Card({
      id: "file-info",
      tone: "panel",
      pad: 18,
      gap: 12,
      children: [
        h_flex()
          .gap(10)
          .items_center()
          .child(
            v_flex()
              .size(32)
              .flex_none()
              .items_center()
              .justify_center()
              .rounded(k.radius.md)
              .bg(k.bg.raised)
              .border_1()
              .border_color(k.line.soft)
              .child(Icon(icon, { size: k.icon.md, color: k.text.secondary })),
          )
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .gap(1)
              .child(Text(m.name, { weight: "semibold", truncate: true }))
              .child(Text(title, { size: "sm", tone: "secondary" })),
          ),
        v_flex()
          .gap(6)
          .child(row(t("filetab.info.size-label"), size))
          .child(row(t("filetab.info.type-label"), info.type || t("filetab.info.unknown"), Boolean(info.type)))
          .child(row(t("filetab.info.path-label"), where, true)),
        ...(m.on
          ? []
          : [
              h_flex()
                .gap(10)
                .items_center()
                .child(
                  Button("file-info-open", t("filetab.info.open-external"), {
                    variant: "primary",
                    icon: "external",
                    disabled: this.opening,
                    onClick: (_e, cx) => this.openExternal(cx),
                  }),
                )
                .when(this.failed, (e) => e.child(Text(t("filetab.info.open-failed"), { size: "sm", tone: "error" }).role("alert"))),
            ]),
      ],
    });
    return v_flex()
      .id("file-info-wrap")
      .size_full()
      .items_center()
      .justify_center()
      .p(24)
      .bg(k.bg.card)
      .child(card.w_full().max_w(440));
  }
}
