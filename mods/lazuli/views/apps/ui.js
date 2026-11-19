// Pieces the app views share on top of ui/kit.js: a modal over the view, a short-lived notice strip, a plain
// section heading, a mono log block, and the press that gives a view the keyboard. Colors come from tokens() like
// every other view.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { tokens, withAlpha } from "../../ui/tokens.js";
import { Text, Button, IconButton, Banner, Icon } from "../../ui/kit.js";

const stop = (_e, cx) => cx.stop_propagation();

/** A press anywhere on a view gives its focus handle the keyboard (its keys work after a click), except a press on
 *  one of its text fields (wrapped with `inField`) or while `busy()` says a field is in use. GPUI hands a press to
 *  the innermost element first, so the field marks it before the root sees it. */
export function pressFocus(view, busy = () => false) {
  return () => {
    if (view.pressedField) view.pressedField = false;
    else if (!busy()) view.handle.focus();
  };
}

/** A text field whose press keeps its own focus (see pressFocus). */
export function inField(view, el) {
  return div()
    .flex_1()
    .min_w(0)
    .on_mouse_down("left", () => {
      view.pressedField = true;
    })
    .child(el);
}

/** A modal card over the whole view: a scrim that closes it on a click, the card centered. `actions`:
 *  `[{ id, label, variant?, icon?, kbd?, onClick, disabled? }]`, the last one on the right. */
export function Dialog({ id, title, body, actions = [], onDismiss, dismissLabel, width = 460 } = {}) {
  const k = tokens();
  const card = v_flex()
    .id(`${id}-card`)
    .w(width)
    .max_w_full()
    .p(k.space.xl + 2)
    .gap(k.space.lg + 2)
    .rounded(k.radius.lg + 2)
    .border_1()
    .border_color(k.line.soft)
    .bg(k.bg.popover)
    .shadow_lg()
    .role("dialog")
    .accessibility_label(title ?? "")
    .on_mouse_down("left", stop)
    .child(
      h_flex()
        .gap(8)
        .items_start()
        .child(Text(title ?? "", { size: "lg", weight: "semibold" }).flex_1().min_w(0))
        .when(Boolean(onDismiss), (e) => e.child(IconButton(`${id}-x`, "x", dismissLabel ?? "", { onClick: onDismiss }))),
    )
    .when(Boolean(body), (e) => e.child(body))
    .when(actions.length > 0, (e) =>
      e.child(
        h_flex()
          .justify_end()
          .gap(8)
          .children(actions.map((a) => Button(a.id, a.label, { variant: a.variant ?? "secondary", icon: a.icon, kbd: a.kbd, onClick: a.onClick, disabled: a.disabled }))),
      ),
    );
  return div()
    .id(id)
    .absolute()
    .inset_0()
    .bg(withAlpha(k.bg.app, 0.72))
    .on_mouse_down("left", (e, cx) => onDismiss?.(e, cx))
    .child(v_flex().size_full().p(16).items_center().justify_center().child(card));
}

/** A notice the view shows for a few seconds: `show(cx, { tone, text, body?, action? })`, drawn by `render(id)`
 *  as a Banner (null when nothing shows). `action`: `{ label, onClick }`. */
export class Notice {
  constructor(ms = 6000) {
    this.ms = ms;
    this.value = null;
    this.seq = 0;
  }

  show(cx, value) {
    const seq = ++this.seq;
    this.value = value;
    cx.notify();
    cx.timer.after(value.ms ?? this.ms, (cx) => {
      if (this.seq !== seq) return;
      this.value = null;
      cx.notify();
    });
  }

  clear(cx) {
    this.seq += 1;
    this.value = null;
    cx?.notify();
  }

  render(id, dismissLabel) {
    const v = this.value;
    if (!v) return null;
    const actions = v.action ? [{ id: `${id}-act`, label: v.action.label, onClick: (e, cx) => (this.clear(cx), v.action.onClick(e, cx)) }] : [];
    return Banner({ id, tone: v.tone ?? "info", title: v.text, body: v.body, actions, onDismiss: (_e, cx) => this.clear(cx), dismissLabel });
  }
}

/** A small heading inside a pane: icon, title, optional trailing elements. */
export function PaneHeading(title, { icon, count, trailing = [] } = {}) {
  const k = tokens();
  return h_flex()
    .flex_none()
    .h(k.row.sm)
    .gap(7)
    .items_center()
    .when(Boolean(icon), (e) => e.child(Icon(icon, { size: 13, color: k.text.secondary })))
    .child(Text(title, { size: "sm", weight: "semibold", nowrap: true }))
    .when(count !== undefined && count !== null, (e) => e.child(Text(String(count), { size: "sm", tone: "tertiary", mono: true })))
    .child(div().flex_1())
    .children(trailing);
}

/** Lines of a log or a terminal screen in the code font on a raised block, the newest last. */
export function LogBlock(id, lines, { maxHeight = 240, tone = "secondary" } = {}) {
  const k = tokens();
  return v_flex()
    .id(id)
    .w_full()
    .max_h(maxHeight)
    .p(8)
    .gap(0)
    .rounded(k.radius.md)
    .bg(k.bg.raised)
    .border_1()
    .border_color(k.line.soft)
    .overflow_y_scrollbar()
    .children(lines.map((l) => Text(l === "" ? " " : l, { size: "xs", mono: true, tone }).whitespace_normal()));
}

/** A label: value line in a facts list. */
export function Fact(label, value) {
  return h_flex()
    .gap(10)
    .items_start()
    .min_w(0)
    .child(Text(label, { size: "sm", tone: "tertiary", nowrap: true }).w(92).flex_none())
    .child(typeof value === "string" ? Text(value, { size: "sm" }).flex_1().min_w(0).whitespace_normal() : div().flex_1().min_w(0).child(value));
}

/** A thin progress bar from 0 to 1 in the accent (or `color`). */
export function Bar(ratio, { color, height = 4 } = {}) {
  const k = tokens();
  const r = Math.max(0, Math.min(1, Number(ratio) || 0));
  return div()
    .w_full()
    .h(height)
    .rounded(height / 2)
    .bg(k.bg.hover)
    .child(div().h_full().rounded(height / 2).bg(color ?? k.accent).w(`${Math.round(r * 1000) / 10}%`));
}
