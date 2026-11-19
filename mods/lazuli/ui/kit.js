// lazuli's component kit: the direction A · Lapis look (docs/mockups/a-lapis/) as element helpers over
// gpui-kit and gpui-base. Every color, font and size comes from `tokens()`; every text argument arrives
// already translated (`t(key)` in the view). Helpers return ordinary elements, so callers keep chaining
// (`.flex_1()`, `.mt(8)`, …).
//
// States: interactive helpers draw rest, hover, pressed, focus, selected and disabled natively. `look:
// "hover" | "active" | "focus"` draws one of those states at rest, for the gallery's screenshots.

import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex, Button as BaseButton, Checkbox as BaseCheckbox, Input } from "gpui-base";
import { tokens, withAlpha } from "./tokens.js";

const UI = "mods/lazuli/ui";
const TRANSPARENT = "#00000000";

/** The kit's assets, as paths in the app home (`svg()`/`image()` resolve against it, H/AGENTS.md:902-905). */
export const ICONS_DIR = `${UI}/icons`;
export const LOGO = `${UI}/logo.svg`;
export const LOGO_MARK = `${UI}/logo-mark.svg`;

/** Agent marks Herdr ships in its app home (H/icons/, notices in H/icons/LICENSES.md), referenced, not copied.
 *  `tint`: a one-color glyph drawn with `svg()` in the text color; else a full-color `image()`. */
export const AGENT_MARKS = Object.freeze({
  claude: Object.freeze({ path: "icons/claude.svg", tint: false }),
  codex: Object.freeze({ path: "icons/codex.svg", tint: false }),
  omp: Object.freeze({ path: "icons/omp.svg", tint: true }),
});

/** The color for a tone name: text tiers, accents, agent states and message tones. */
export function toneColor(tone, k = tokens()) {
  switch (tone) {
    case "primary":
      return k.text.primary;
    case "secondary":
    case "default":
      return k.text.secondary;
    case "tertiary":
      return k.text.tertiary;
    case "accent":
      return k.accent;
    case "accent2":
      return k.accent2;
    case "onAccent":
      return k.text.onAccent;
    default:
      return k.state[tone] ?? k.text.primary;
  }
}

// Text style for a size step ("xs" … "xxl"), in the UI or code font.
function type(el, k, size = "md", mono = false) {
  return el
    .font_family(mono ? k.fonts.mono : k.fonts.ui)
    .text_size(k.fontSize[size])
    .line_height(`${k.lineHeight[size]}px`);
}

// Keeps a press on a control from starting a window drag in `window_drag` blocks, as Herdr's own tab bar
// does on its Buttons (H/mods/tabs-my-before-shepherdr/main.js:93-97; H/mods/workspace-chrome/main.js:30).
const stopDrag = (_e, cx) => cx.stop_propagation();

/* ---------- layout and text ---------- */

/** A view's root: fills its block, sets the UI font, base text size, text color and background. */
export function ViewRoot(id, { bg } = {}) {
  const k = tokens();
  return type(v_flex().id(id).size_full().min_h(0), k, "md")
    .text_color(k.text.primary)
    .bg(bg ?? k.bg.card);
}

/** A run of text. `tone`: primary, secondary, tertiary, accent, accent2, onAccent, or a state
 *  (working, blocked, done, idle, unknown, success, warning, error, info). */
export function Text(text, { size = "md", tone = "primary", weight, mono = false, truncate = false, nowrap = false, color } = {}) {
  const k = tokens();
  return type(div(), k, size, mono)
    .text_color(color ?? toneColor(tone, k))
    .when(Boolean(weight), (el) => el.font_weight(k.weight[weight] ?? weight))
    .when(truncate, (el) => el.min_w(0).truncate())
    .when(nowrap && !truncate, (el) => el.whitespace_nowrap())
    .child(text);
}

/** Takes the free space in a row or column. */
export function Spacer() {
  return div().flex_1();
}

/** A 1 px rule: across (default) or upright (`vertical`, `length` px tall). */
export function Divider({ vertical = false, length = 14 } = {}) {
  const k = tokens();
  return vertical ? div().w(1).h(length).flex_none().bg(k.line.soft) : div().h(1).w_full().flex_none().bg(k.line.soft);
}

/* ---------- icons and marks ---------- */

/** The path of an icon under ui/icons/ (Lucide, ISC). */
export function iconPath(name) {
  return `${ICONS_DIR}/${name}.svg`;
}

/** A Lucide icon, tinted with `color` or the surrounding text color. */
export function Icon(name, { size, color } = {}) {
  const el = svg(iconPath(name)).size(size ?? tokens().icon.sm).flex_none();
  return color ? el.text_color(color) : el;
}

/** A program's icon as `terminals()`/`agents()` report it (H/herdr.d.ts:151-167): `svg()` in the text color
 *  when `tint`, else full color. A program without an icon gets the terminal glyph. */
export function ProgramIcon(program, { size, color } = {}) {
  const px = size ?? tokens().icon.sm;
  if (!program?.icon) return Icon("terminal", { size: px, color });
  if (program.tint) {
    const el = svg(program.icon).size(px).flex_none();
    return color ? el.text_color(color) : el;
  }
  return image(program.icon).size(px).flex_none();
}

/** An agent's mark by program key (`claude`, `codex`, `omp`); others get the terminal glyph. */
export function AgentMark(key, { size, color } = {}) {
  const mark = AGENT_MARKS[key];
  return ProgramIcon(mark ? { icon: mark.path, tint: mark.tint } : null, { size, color });
}

/** lazuli's logo in full color. */
export function Logo({ size = 20 } = {}) {
  return image(LOGO).size(size).flex_none();
}

/** lazuli's one-color mark, tinted with `color` or the surrounding text color. */
export function LogoMark({ size = 20, color } = {}) {
  const el = svg(LOGO_MARK).size(size).flex_none();
  return color ? el.text_color(color) : el;
}

/** A spinner: the loader arc turning natively once every 900 ms (H/AGENTS.md:1002-1011). */
export function Spinner({ size, color, label } = {}) {
  const k = tokens();
  const arc = svg(iconPath("loader"))
    .size(size ?? k.icon.sm)
    .flex_none()
    .text_color(color ?? k.state.working)
    .spin(900);
  return label ? div().flex_none().role("progress_indicator").accessibility_label(label).child(arc) : arc;
}

/* ---------- small labels ---------- */

/** A keyboard shortcut hint, `⇧⌘P`: code font, 11 px, tertiary. `onSolid` for a primary button's face. */
export function Kbd(keys, { onSolid = false, tone } = {}) {
  const k = tokens();
  return type(div(), k, "xs", true)
    .flex_none()
    .whitespace_nowrap()
    .text_color(onSolid ? k.button.text : toneColor(tone ?? "tertiary", k))
    .when(onSolid, (el) => el.opacity(0.85))
    .child(keys);
}

/** A count pill. `tone`: default (neutral), wait (pyrite: something waits for you), accent.
 *  `ring` draws a 2 px border in that color, to cut the pill out of an icon it sits on. */
export function Count(n, { tone = "default", ring, label } = {}) {
  const k = tokens();
  const fill = tone === "wait" ? k.state.blocked : tone === "accent" ? k.accent : k.bg.hover;
  const ink = tone === "wait" || tone === "accent" ? k.text.onAccent : k.text.secondary;
  return type(h_flex(), k, "xs", true)
    .flex_none()
    .min_w(18)
    .h(18)
    .px(5)
    .items_center()
    .justify_center()
    .rounded(k.radius.full)
    .bg(fill)
    .text_color(ink)
    .when(tone !== "default", (el) => el.font_weight(k.weight.semibold))
    .when(Boolean(ring), (el) => el.border(2).border_color(ring))
    .when(Boolean(label), (el) => el.accessibility_label(label))
    .child(String(n));
}

/** A short status label. `variant`: soft (tone text on a raised fill with a tinted edge), solid (tone fill),
 *  text (tone text only, like the mockup's "리뷰 요청" tags). */
export function Badge(text, { tone = "default", variant = "soft", icon, mono = false } = {}) {
  const k = tokens();
  const color = toneColor(tone, k);
  if (variant === "text") {
    return type(h_flex(), k, "xs", mono)
      .flex_none()
      .gap(4)
      .items_center()
      .whitespace_nowrap()
      .text_color(color)
      .when(Boolean(icon), (el) => el.child(Icon(icon, { size: 12 })))
      .child(text);
  }
  const solid = variant === "solid";
  return type(h_flex(), k, "xs", mono)
    .flex_none()
    .h(18)
    .px(6)
    .gap(4)
    .items_center()
    .rounded(k.radius.sm)
    .whitespace_nowrap()
    .font_weight(k.weight.medium)
    .bg(solid ? color : k.bg.raised)
    .border_1()
    .border_color(solid ? color : withAlpha(color, 0.4))
    .text_color(solid ? k.text.onAccent : color)
    .when(Boolean(icon), (el) => el.child(Icon(icon, { size: 12 })))
    .child(text);
}

/** A bordered tag: PR number, CI state, branch, machine. `tone`: default, pr (primary text in the code
 *  font), ok, fail, run, merged, wait. A chip with `onClick` (and an `id`) is a button. */
export function Chip(label, { id, icon, tone = "default", mono, tooltip, onClick, spin = false } = {}) {
  const k = tokens();
  const color = {
    pr: k.text.primary,
    ok: k.state.success,
    fail: k.state.error,
    run: k.state.working,
    merged: k.state.done,
    wait: k.state.blocked,
  }[tone] ?? k.text.secondary;
  const glyph = icon ? Icon(icon, { size: 12 }) : null;
  let el = type(onClick ? BaseButton.new(id ?? `chip-${label}`).h_flex().tab_index(0) : h_flex(), k, "xs", mono ?? tone === "pr")
    .flex_none()
    .h(k.control.chip)
    .px(6)
    .gap(4)
    .items_center()
    .rounded(k.radius.sm)
    .border_1()
    .border_color(k.line.soft)
    .bg(k.bg.raised)
    .whitespace_nowrap()
    .text_color(color)
    .when(Boolean(glyph), (e) => e.child(spin ? glyph.spin(2400) : glyph))
    .child(label)
    .when(Boolean(tooltip), (e) => e.tooltip(tooltip));
  if (onClick) {
    el = el
      .cursor_pointer()
      .accessibility_label(tooltip ?? label)
      .on_mouse_down("left", stopDrag)
      .on_click(onClick)
      .hover((s) => s.border_color(k.line.strong))
      .focus((s) => s.border_color(k.accent));
  }
  return el;
}

/** A pull request chip: `#51` with the state's glyph. `state`: open, draft, merged, closed. */
export function PrChip(number, { state = "open", id, onClick, tooltip } = {}) {
  const icon = { open: "git-pull-request", draft: "git-pull-request-draft", merged: "git-merge", closed: "circle-x" }[state] ?? "git-pull-request";
  return Chip(`#${number}`, { id, icon, tone: "pr", onClick, tooltip });
}

/** A CI chip with a translated label. `state`: pass, fail, running, pending. */
export function CiChip(state, label, { id, onClick, tooltip } = {}) {
  const spec = {
    pass: ["circle-check", "ok"],
    fail: ["circle-x", "fail"],
    running: ["circle-dashed", "run"],
    pending: ["clock", "default"],
  }[state] ?? ["circle-dot", "default"];
  return Chip(label, { id, icon: spec[0], tone: spec[1], onClick, tooltip, spin: state === "running" });
}

/** A branch chip: the branch name in the code font. */
export function BranchChip(name, { id, onClick, tooltip } = {}) {
  return Chip(name, { id, icon: "git-branch", mono: true, onClick, tooltip: tooltip ?? name });
}

/** An agent state dot. `status`: working, blocked, done (filled), idle (a ring), unknown (faint).
 *  `pulse` breathes it natively; `label` is what a screen reader says, since color alone says nothing. */
export function StatusDot(status, { size = 7, pulse = false, label } = {}) {
  const k = tokens();
  const color = k.state[status] ?? k.state.unknown;
  return div()
    .flex_none()
    .size(size)
    .rounded(k.radius.full)
    .map((el) =>
      status === "idle"
        ? el.border(1.5).border_color(color)
        : status === "unknown" || !k.state[status]
          ? el.bg(withAlpha(color, 0.5))
          : el.bg(color),
    )
    .when(pulse, (el) => el.loop("opacity", { from: 0.45, to: 1, period: 1400 }))
    .when(Boolean(label), (el) => el.accessibility_label(label));
}

/* ---------- buttons ---------- */

/** A text button. `variant`: primary (solid accent), secondary (bordered card), ghost (no fill).
 *  `icon` leads, `kbd` trails (`응답하기 ⌘J`). `size`: md (26 px) or sm (24 px). */
export function Button(id, label, { variant = "secondary", icon, kbd, onClick, disabled = false, tooltip, a11y, size = "md", look } = {}) {
  const k = tokens();
  const primary = variant === "primary";
  const ghost = variant === "ghost";
  const ink = primary ? k.button.text : ghost ? k.text.secondary : k.text.primary;
  const fill = primary ? k.button.bg : ghost ? TRANSPARENT : k.bg.card;
  const edge = primary ? k.button.bg : ghost ? TRANSPARENT : k.line.strong;
  const hover = (s) => (primary ? s.opacity(0.9) : s.bg(k.bg.hover).text_color(k.text.primary));
  const active = (s) => (primary ? s.opacity(0.8) : s.bg(k.bg.selected).text_color(k.text.primary));
  const focus = (s) => s.border_color(primary ? k.text.primary : k.accent);
  let el = type(BaseButton.new(id).h_flex().tab_index(0), k, "sm")
    .flex_none()
    .h(size === "sm" ? k.control.sm : k.control.md)
    .px(size === "sm" ? 8 : 10)
    .gap(6)
    .items_center()
    .rounded(k.radius.md)
    .border_1()
    .border_color(edge)
    .bg(fill)
    .text_color(ink)
    .whitespace_nowrap()
    .when(primary, (e) => e.font_weight(k.weight.semibold))
    .accessibility_label(a11y ?? label)
    .disabled(disabled)
    .when(Boolean(tooltip), (e) => e.tooltip(tooltip))
    .when(Boolean(icon), (e) => e.child(Icon(icon, { size: 14 })))
    .child(label)
    .when(Boolean(kbd), (e) => e.child(Kbd(kbd, { onSolid: primary })));
  if (disabled) return el.opacity(0.5).cursor_default();
  el = el.cursor_pointer().on_mouse_down("left", stopDrag).hover(hover).active(active).focus(focus);
  if (onClick) el = el.on_click(onClick);
  if (look === "hover") el = el.map(hover);
  if (look === "active") el = el.map(active);
  if (look === "focus") el = el.map(focus);
  return el;
}

/** An icon-only button, 26 px (`size: "lg"`: 32 px, the panel rail). `label` is announced and shown as the
 *  tooltip. `selected`: the rail's open panel (accent glyph on the selected fill). `count` puts a pyrite
 *  count on its corner (the bell). */
export function IconButton(id, icon, label, { onClick, selected = false, disabled = false, size = "md", iconSize, tooltip = true, count, look } = {}) {
  const k = tokens();
  const side = size === "lg" ? k.control.lg : k.control.md;
  const hover = (s) => s.bg(selected ? k.bg.selected : k.bg.hover).text_color(selected ? k.accent : k.text.primary);
  const active = (s) => s.bg(k.bg.selected);
  const focus = (s) => s.border_color(k.accent);
  let el = BaseButton.new(id)
    .h_flex()
    .tab_index(0)
    .relative()
    .flex_none()
    .size(side)
    .items_center()
    .justify_center()
    .rounded(k.radius.md)
    .border_1()
    .border_color(TRANSPARENT)
    .bg(selected ? k.bg.selected : TRANSPARENT)
    .text_color(selected ? k.accent : k.text.secondary)
    .selected(selected)
    .accessibility_label(label)
    .disabled(disabled)
    .when(tooltip !== false, (e) => e.tooltip(typeof tooltip === "string" ? tooltip : label))
    .child(Icon(icon, { size: iconSize ?? (size === "lg" ? k.icon.md : k.icon.sm) }))
    .when(count !== undefined && count !== null && count !== 0, (e) =>
      e.child(Count(count, { tone: "wait", ring: k.bg.app }).absolute().top(-3).right(-4)),
    );
  if (disabled) return el.opacity(0.5).cursor_default();
  el = el.cursor_pointer().on_mouse_down("left", stopDrag).hover(hover).active(active).focus(focus);
  if (onClick) el = el.on_click(onClick);
  if (look === "hover") el = el.map(hover);
  if (look === "active") el = el.map(active);
  if (look === "focus") el = el.map(focus);
  return el;
}

/** A labelled checkbox (gpui-base `Checkbox`, controlled: `onChange(checked, cx)`). */
export function CheckBox(id, checked, onChange, { label, disabled = false, look } = {}) {
  const k = tokens();
  const box = div()
    .flex_none()
    .size(14)
    .flex()
    .items_center()
    .justify_center()
    .rounded(k.radius.sm)
    .border(1.5)
    .border_color(checked ? k.accent : k.line.strong)
    .bg(checked ? k.accent : TRANSPARENT)
    .text_color(k.text.onAccent)
    .when(checked, (e) => e.child(Icon("check", { size: 11 })));
  const focus = (s) => s.border_color(k.accent);
  let el = type(BaseCheckbox.new(id).h_flex().tab_index(0), k, "md")
    .gap(8)
    .items_center()
    .px(2)
    .rounded(k.radius.sm)
    .border_1()
    .border_color(TRANSPARENT)
    .text_color(k.text.primary)
    .checked(checked)
    .disabled(disabled)
    .when(Boolean(label), (e) => e.accessibility_label(label))
    .child(box)
    .when(Boolean(label), (e) => e.child(label));
  if (disabled) return el.opacity(0.5).cursor_default();
  el = el.cursor_pointer().focus(focus).on_change((value, cx) => onChange?.(value, cx));
  if (look === "focus") el = el.map(focus);
  return el;
}

/* ---------- rows, headers, cards ---------- */

/** A list row (nav item, agent, file): `leading` element or `icon` name, `label`, `detail` (a short code-font
 *  note: "23분", "#47", "M"), then `trailing` elements. `selected` is the open item (selected fill),
 *  `current` the focused one (hover fill); `size`: md (28 px, 13 px text) or sm (24 px, 12 px). */
export function Row(id, {
  label,
  icon,
  leading,
  detail,
  detailTone = "tertiary",
  trailing = [],
  selected = false,
  current = false,
  indent = 0,
  size = "md",
  tone = "secondary",
  mono = false,
  onClick,
  onSecondaryClick,
  tooltip,
  look,
} = {}) {
  const k = tokens();
  const strong = selected || current;
  const hover = (s) => s.bg(selected ? k.bg.selected : k.bg.hover).text_color(k.text.primary);
  let el = type(h_flex().id(id), k, size === "sm" ? "sm" : "md")
    .flex_none()
    .w_full()
    .min_w(0)
    .h(size === "sm" ? k.row.sm : k.row.md)
    .pl(8 + indent)
    .pr(8)
    .gap(8)
    .items_center()
    .rounded(size === "sm" ? k.radius.sm : k.radius.md)
    .role("list_item")
    .aria_selected(selected)
    .text_color(strong ? k.text.primary : toneColor(tone, k))
    .when(selected, (e) => e.bg(k.bg.selected))
    .when(current && !selected, (e) => e.bg(k.bg.hover))
    .when(Boolean(leading), (e) => e.child(leading))
    .when(!leading && Boolean(icon), (e) => e.child(Icon(icon, { size: 14 })))
    .child(
      type(div(), k, size === "sm" ? "sm" : "md", mono)
        .flex_1()
        .min_w(0)
        .truncate()
        .when(selected, (e) => e.font_weight(k.weight.medium))
        .child(label ?? ""),
    )
    .when(detail !== undefined && detail !== null && detail !== "", (e) =>
      e.child(type(div(), k, "xs", true).flex_none().whitespace_nowrap().text_color(toneColor(detailTone, k)).child(String(detail))),
    )
    .children(trailing)
    .when(Boolean(tooltip), (e) => e.tooltip(tooltip));
  if (onClick) el = el.cursor_pointer().on_click(onClick).hover(hover);
  if (onSecondaryClick) el = el.on_mouse_down("right", onSecondaryClick);
  if (look === "hover") el = el.map(hover);
  return el;
}

/** A section heading. `variant`: section (12 px semibold: icon, title, count, then shortcut on the right),
 *  sidebar (11 px tertiary, like "스페이스"), column (board column: colored glyph, title, count). */
export function SectionHeader({ id, icon, iconColor, title, count, shortcut, trailing = [], variant = "section" } = {}) {
  const k = tokens();
  if (variant === "sidebar") {
    return type(h_flex(), k, "xs")
      .when(Boolean(id), (e) => e.id(id))
      .flex_none()
      .h(26)
      .px(8)
      .gap(6)
      .items_center()
      .role("heading")
      .text_color(k.text.tertiary)
      .font_weight(k.weight.medium)
      .child(div().flex_1().min_w(0).truncate().child(title))
      .children(trailing);
  }
  return type(h_flex(), k, "sm")
    .when(Boolean(id), (e) => e.id(id))
    .flex_none()
    .h(k.row.sm)
    .gap(7)
    .items_center()
    .role("heading")
    .text_color(k.text.primary)
    .when(Boolean(icon), (e) => e.child(Icon(icon, { size: variant === "column" ? 13 : 14, color: iconColor ?? k.text.secondary })))
    .child(div().flex_none().font_weight(k.weight.semibold).whitespace_nowrap().child(title))
    .when(count !== undefined && count !== null, (e) => e.child(type(div(), k, "sm", true).text_color(k.text.tertiary).child(String(count))))
    .child(Spacer())
    .children(trailing)
    .when(Boolean(shortcut), (e) => e.child(Kbd(shortcut)));
}

/** A card: card fill, soft border, 10 px corners. `tone`: default, wait (surface fill: something waits
 *  for you), panel (adds the small shadow of the layout's cards). `onClick` makes it a target. */
export function Card({ id, tone = "default", pad, gap = 6, children = [], selected = false, onClick, look } = {}) {
  const k = tokens();
  const hover = (s) => s.border_color(k.line.strong);
  let el = v_flex()
    .when(Boolean(id), (e) => e.id(id))
    .min_w(0)
    .gap(gap)
    .p(pad ?? k.space.md + k.space.xxs)
    .rounded(k.radius.lg)
    .bg(tone === "wait" ? k.bg.surface : k.bg.card)
    .border_1()
    .border_color(selected ? k.accent : k.line.soft)
    .when(tone === "panel", (e) => e.shadow_sm())
    .children(children);
  if (onClick && id) el = el.cursor_pointer().on_click(onClick).hover(hover);
  if (look === "hover") el = el.map(hover);
  return el;
}

/* ---------- inputs ---------- */

/** Watches an `InputState`'s focus: returns `{ focused }`, kept current and redrawn. Call it in `init`,
 *  where the state was made. */
export function trackFocus(state) {
  const box = { focused: false };
  state.on("focus", (_e, cx) => {
    box.focused = true;
    cx.notify();
  });
  state.on("blur", (_e, cx) => {
    box.focused = false;
    cx.notify();
  });
  return box;
}

/** A one-line text field around an `InputState` (made in `init`; the placeholder is the state's).
 *  `focused` draws the accent edge (from `trackFocus`), `invalid` the error edge; `icon` leads. */
export function TextInput(state, { id, focused = false, invalid = false, mono = false, icon, a11y } = {}) {
  const k = tokens();
  const edge = invalid ? k.state.error : focused ? k.accent : k.line.strong;
  return type(h_flex().id(id ?? "text-input"), k, "md", mono)
    .w_full()
    .min_w(0)
    .h(k.row.md)
    .px(8)
    .gap(6)
    .items_center()
    .rounded(k.radius.md)
    .border_1()
    .border_color(edge)
    .bg(k.bg.card)
    .text_color(k.text.primary)
    .cursor_text()
    .when(Boolean(a11y), (e) => e.accessibility_label(a11y))
    .on_mouse_down("left", stopDrag)
    .on_click(() => state.focus())
    .when(Boolean(icon), (e) => e.child(Icon(icon, { size: 14, color: k.text.tertiary })))
    .child(Input.new(state).flex_1().min_w(0).h_full().font_family(mono ? k.fonts.mono : k.fonts.ui).text_size(k.fontSize.md).text_color(k.text.primary));
}

/** A labelled form field: label above, the control, then the error (announced) or a hint below. */
export function Field({ id, label, hint, error, control } = {}) {
  const k = tokens();
  return v_flex()
    .when(Boolean(id), (e) => e.id(id))
    .w_full()
    .min_w(0)
    .gap(6)
    .when(Boolean(label), (e) => e.child(Text(label, { size: "sm", tone: "secondary", weight: "medium" })))
    .child(control)
    .when(Boolean(error), (e) => e.child(h_flex().gap(6).items_center().role("alert").text_color(k.state.error).child(Icon("circle-x", { size: 12 })).child(Text(error, { size: "sm", tone: "error" }))))
    .when(!error && Boolean(hint), (e) => e.child(Text(hint, { size: "sm", tone: "tertiary" })));
}

/* ---------- tabs ---------- */

/** A segmented control (Edit / Split / Preview). `items`: `[{ key, label, icon?, disabled? }]`;
 *  `onChange(key, cx)` runs for a new key. */
export function Segmented(id, items, value, onChange, { label } = {}) {
  const k = tokens();
  return h_flex()
    .id(id)
    .flex_none()
    .h(k.control.md)
    .p(2)
    .gap(2)
    .items_center()
    .rounded(k.radius.md)
    .bg(k.bg.surface)
    .border_1()
    .border_color(k.line.soft)
    .role("tab_list")
    .when(Boolean(label), (e) => e.accessibility_label(label))
    .children(
      items.map((item, i) => {
        const on = item.key === value;
        const off = Boolean(item.disabled);
        let tab = type(BaseButton.new(`${id}-${item.key}`).h_flex().tab_index(0), k, "sm")
          .h_full()
          .px(9)
          .gap(5)
          .items_center()
          .rounded(k.radius.sm)
          .border_1()
          .border_color(on ? k.line.soft : TRANSPARENT)
          .bg(on ? k.bg.card : TRANSPARENT)
          .text_color(on ? k.text.primary : k.text.secondary)
          .whitespace_nowrap()
          .role("tab")
          .selected(on)
          .set_position(i + 1, items.length)
          .accessibility_label(item.label)
          .disabled(off)
          .when(Boolean(item.icon), (e) => e.child(Icon(item.icon, { size: 13 })))
          .child(item.label);
        if (off) return tab.opacity(0.5);
        tab = tab.cursor_pointer().on_mouse_down("left", stopDrag).focus((s) => s.border_color(k.accent));
        if (!on) tab = tab.hover((s) => s.text_color(k.text.primary)).on_click((e, cx) => onChange(item.key, cx));
        return tab;
      }),
    );
}

/** A tab bar with an accent underline under the open tab. `items`: `[{ key, label, count? }]`. */
export function TabBar(id, items, value, onChange, { label } = {}) {
  const k = tokens();
  return h_flex()
    .id(id)
    .flex_none()
    .w_full()
    .h(k.row.lg)
    .gap(16)
    .px(12)
    .items_center()
    .border_b(1)
    .border_color(k.line.soft)
    .role("tab_list")
    .when(Boolean(label), (e) => e.accessibility_label(label))
    .children(
      items.map((item, i) => {
        const on = item.key === value;
        let tab = type(BaseButton.new(`${id}-${item.key}`).h_flex().tab_index(0), k, "sm")
          .relative()
          .h_full()
          .gap(6)
          .items_center()
          .border_1()
          .border_color(TRANSPARENT)
          .text_color(on ? k.text.primary : k.text.secondary)
          .font_weight(on ? k.weight.semibold : k.weight.regular)
          .whitespace_nowrap()
          .role("tab")
          .selected(on)
          .set_position(i + 1, items.length)
          .accessibility_label(item.label)
          .cursor_pointer()
          .on_mouse_down("left", stopDrag)
          .focus((s) => s.border_color(k.accent))
          .child(item.label)
          .when(item.count !== undefined && item.count !== null, (e) => e.child(type(div(), k, "xs", true).text_color(k.text.tertiary).child(String(item.count))))
          .when(on, (e) => e.child(div().absolute().left_0().right_0().bottom_0().h(2).rounded(1).bg(k.accent)));
        if (!on) tab = tab.hover((s) => s.text_color(k.text.primary)).on_click((e, cx) => onChange(item.key, cx));
        return tab;
      }),
    );
}

/* ---------- menus ---------- */

/** A menu surface: popover fill, soft border, shadow; holds MenuItem, MenuLabel and MenuSeparator. */
export function Menu({ id, children = [], width = 240, label } = {}) {
  const k = tokens();
  return type(v_flex(), k, "md")
    .when(Boolean(id), (e) => e.id(id))
    .w(width)
    .p(4)
    .gap(1)
    .rounded(k.radius.lg)
    .bg(k.bg.popover)
    .border_1()
    .border_color(k.line.soft)
    .shadow_md()
    .text_color(k.text.primary)
    .role("menu")
    .when(Boolean(label), (e) => e.accessibility_label(label))
    .children(children);
}

/** A menu item: `icon`, `label`, `detail`, `kbd`. `selected` is the keyboard highlight, `checked` adds a
 *  check, `danger` paints it in the error tone. */
export function MenuItem(id, { label, icon, detail, kbd, onClick, selected = false, checked = false, danger = false, disabled = false, look } = {}) {
  const k = tokens();
  const hover = (s) => s.bg(selected ? k.bg.selected : k.bg.hover);
  const focus = (s) => s.border_color(k.accent);
  let el = type(BaseButton.new(id).h_flex().tab_index(0), k, "md")
    .w_full()
    .h(k.row.md)
    .px(8)
    .gap(8)
    .items_center()
    .rounded(k.radius.md)
    .border_1()
    .border_color(TRANSPARENT)
    .bg(selected ? k.bg.selected : TRANSPARENT)
    .text_color(danger ? k.state.error : k.text.primary)
    .role("menu_item")
    .selected(selected)
    .accessibility_label(label)
    .disabled(disabled)
    .child(
      icon
        ? Icon(icon, { size: 14, color: danger ? k.state.error : k.text.secondary })
        : div().size(14).flex_none(),
    )
    .child(div().flex_1().min_w(0).truncate().child(label))
    .when(Boolean(detail), (e) => e.child(Text(detail, { size: "sm", tone: "tertiary", nowrap: true })))
    .when(checked, (e) => e.child(Icon("check", { size: 14, color: k.accent })))
    .when(Boolean(kbd), (e) => e.child(Kbd(kbd)));
  if (disabled) return el.opacity(0.5).cursor_default();
  el = el.cursor_pointer().hover(hover).focus(focus);
  if (onClick) el = el.on_click(onClick);
  if (look === "hover") el = el.map(hover);
  if (look === "focus") el = el.map(focus);
  return el;
}

/** A small heading inside a menu. */
export function MenuLabel(text) {
  const k = tokens();
  return type(div(), k, "xs").h(k.row.sm).px(8).flex().items_center().text_color(k.text.tertiary).font_weight(k.weight.medium).child(text);
}

/** A rule between menu groups. */
export function MenuSeparator() {
  return Divider().my(4);
}

/* ---------- empty, banner, tooltip ---------- */

/** An empty state: a glyph in a soft disc, a title, a sentence, and an optional action element. */
export function Empty({ id, icon = "inbox", title, body, action } = {}) {
  const k = tokens();
  return v_flex()
    .when(Boolean(id), (e) => e.id(id))
    .w_full()
    .items_center()
    .justify_center()
    .gap(6)
    .p(k.space.xxl)
    .child(
      div()
        .size(32)
        .flex()
        .items_center()
        .justify_center()
        .rounded(k.radius.full)
        .bg(k.bg.raised)
        .border_1()
        .border_color(k.line.soft)
        .child(Icon(icon, { size: k.icon.md, color: k.text.tertiary })),
    )
    .when(Boolean(title), (e) => e.child(Text(title, { weight: "medium" }).mt(4)))
    .when(Boolean(body), (e) => e.child(Text(body, { size: "sm", tone: "secondary" }).max_w(320).text_center()))
    .when(Boolean(action), (e) => e.child(div().mt(6).child(action)));
}

/** A dashed placeholder slot, like an empty board column ("리뷰 기다리는 PR 없음"). */
export function EmptySlot(text) {
  const k = tokens();
  return type(h_flex(), k, "sm")
    .w_full()
    .h(38)
    .px(8)
    .items_center()
    .justify_center()
    .rounded(k.radius.lg)
    .border_1()
    .border_dashed()
    .border_color(k.line.soft)
    .text_color(k.text.tertiary)
    .child(div().truncate().child(text));
}

const BANNER_ICON = { info: "info", success: "circle-check", warning: "triangle-alert", error: "circle-x" };

/** A message strip. `tone`: info, success, warning, error. `actions`: `[{ id, label, onClick, variant?, kbd? }]`
 *  as buttons on the right; `onDismiss` adds a close button labelled `dismissLabel`. Errors and warnings are
 *  announced as alerts. */
export function Banner({ id, tone = "info", title, body, actions = [], onDismiss, dismissLabel, icon } = {}) {
  const k = tokens();
  const color = toneColor(tone, k);
  return type(h_flex().id(id ?? `banner-${tone}`), k, "md")
    .w_full()
    .min_w(0)
    .gap(10)
    .pl(12)
    .pr(onDismiss ? 6 : 8)
    .py(8)
    .items_center()
    .rounded(k.radius.md)
    .bg(withAlpha(color, 0.1))
    .border_1()
    .border_color(withAlpha(color, 0.45))
    .text_color(k.text.primary)
    .role(tone === "error" || tone === "warning" ? "alert" : "status")
    .child(Icon(icon ?? BANNER_ICON[tone] ?? "info", { size: k.icon.md, color }))
    .child(
      v_flex()
        .flex_1()
        .min_w(0)
        .gap(1)
        .when(Boolean(title), (e) => e.child(Text(title, { weight: "medium" })))
        .when(Boolean(body), (e) => e.child(Text(body, { size: "sm", tone: "secondary" }))),
    )
    .children(actions.map((a) => Button(a.id, a.label, { variant: a.variant ?? "secondary", kbd: a.kbd, icon: a.icon, onClick: a.onClick, size: "sm" })))
    .when(Boolean(onDismiss), (e) =>
      e.child(IconButton(`${id ?? `banner-${tone}`}-dismiss`, "x", dismissLabel ?? "", { onClick: onDismiss, tooltip: Boolean(dismissLabel) })),
    );
}

/** Adds a hover label (half a second, drawn by the shell). Works on div/h_flex/v_flex and Buttons only
 *  (H/gpui-kit.d.ts:947-969); it is not a substitute for an accessibility label. */
export function withTooltip(el, text) {
  return el.tooltip(text);
}
