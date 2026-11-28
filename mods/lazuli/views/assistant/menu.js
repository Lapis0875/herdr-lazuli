// The Assistant's dropdown menus (the approval card's More, the chat header's model menu, the list's new-chat
// picker): a gpui-base `Popover` holding a kit `Menu`, controlled by the view's own flag, opened by a press on its
// trigger and closed by a pick, a press outside or Escape.
//
// The trigger must let the press through. The Popover opens from a mouse-down listener around its trigger, and
// mouse-down bubbles from the trigger outward; kit Button and IconButton stop it there (so a press on a control
// never starts a window drag, ui/kit.js stopDrag), which kept these menus from ever opening. The triggers here draw
// the same as kit's ghost Button and IconButton without that listener, as insights' filter menus build theirs
// (H/mods/insights/main.js filterMenu).

import { Popover, Button as BaseButton } from "gpui-base";
import { tokens } from "../../ui/tokens.js";
import { Icon } from "../../ui/kit.js";

const TRANSPARENT = "#00000000";

/** A ghost text button with a trailing chevron, as kit `Button(…, {variant: "ghost", size: "sm"})` draws it. `mono`
 *  sets the label in the code font (a model id). `open` keeps the pressed fill while its menu shows. */
export function MenuButton(id, label, { open = false, mono = false, a11y, tooltip } = {}) {
  const k = tokens();
  return BaseButton.new(id)
    .h_flex()
    .tab_index(0)
    .flex_none()
    .h(k.control.sm)
    .px(8)
    .gap(4)
    .items_center()
    .rounded(k.radius.md)
    .border_1()
    .border_color(TRANSPARENT)
    .bg(open ? k.bg.selected : TRANSPARENT)
    .font_family(mono ? k.fonts.mono : k.fonts.ui)
    .text_size(mono ? k.fontSize.xs : k.fontSize.sm)
    .line_height(`${mono ? k.lineHeight.xs : k.lineHeight.sm}px`)
    .text_color(open ? k.text.primary : k.text.secondary)
    .whitespace_nowrap()
    .cursor_pointer()
    .accessibility_label(a11y ?? label)
    .when(Boolean(tooltip), (e) => e.tooltip(tooltip))
    .hover((s) => s.bg(k.bg.hover).text_color(k.text.primary))
    .active((s) => s.bg(k.bg.selected).text_color(k.text.primary))
    .focus((s) => s.border_color(k.accent))
    .child(label)
    .child(Icon("chevron-down", { size: 12, color: k.text.tertiary }));
}

/** An icon-only button, as kit `IconButton` draws it (26 px, label as tooltip); `open` is its selected look. */
export function MenuIconButton(id, icon, label, { open = false } = {}) {
  const k = tokens();
  return BaseButton.new(id)
    .h_flex()
    .tab_index(0)
    .flex_none()
    .size(k.control.md)
    .items_center()
    .justify_center()
    .rounded(k.radius.md)
    .border_1()
    .border_color(TRANSPARENT)
    .bg(open ? k.bg.selected : TRANSPARENT)
    .text_color(open ? k.accent : k.text.secondary)
    .selected(open)
    .cursor_pointer()
    .accessibility_label(label)
    .tooltip(label)
    .hover((s) => s.bg(open ? k.bg.selected : k.bg.hover).text_color(open ? k.accent : k.text.primary))
    .active((s) => s.bg(k.bg.selected))
    .focus((s) => s.border_color(k.accent))
    .child(Icon(icon, { size: k.icon.sm }));
}

/** The Popover around `trigger`: shown while `open`, `onOpen(open, cx)` told of every change the Popover makes (a
 *  press on the trigger, a press outside, Escape). `menu()` builds the content only while it shows. */
export function MenuPopover(id, { trigger, open, onOpen, menu, anchor }) {
  let el = Popover.new(id)
    .trigger(trigger)
    .open(open)
    .on_open_change((value, cx) => {
      onOpen(value, cx);
      cx.notify();
    });
  if (anchor) el = el.anchor(anchor);
  return open ? el.content(menu()) : el;
}
