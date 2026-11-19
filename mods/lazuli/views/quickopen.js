// The quick-open dialog (⌘⇧O, DESIGN B11): the files under the focused folder (sys/filetabs.js
// listFiles: git's list in a repository, else find), ranked fuzzily as you type (search), opened per B2.
// ↑/↓ move, ↩ opens a preview tab, ⌘↩ (or ⌘-click) a pinned one, Esc closes (Herdr's dialog).
// "Whole repository" lists from the repository's top folder instead. Props {root, on, space, widen,
// overlay}; mounted with `preview: true` it only draws.

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, ScrollHandle } from "gpui-base";
import { closeOverlay, home, props as hostProps } from "herdr";
import { t } from "../core/i18n.js";
import { basename, kindOf, tilde } from "../core/paths.js";
import { listFiles, open, search } from "../sys/filetabs.js";
import { tokens } from "../ui/tokens.js";
import { CheckBox, Empty, Icon, Kbd, Spinner, Text, TextInput, ViewRoot, trackFocus } from "../ui/kit.js";

const KIND_ICON = { md: "file-text", html: "file-code", svg: "image", image: "image", pdf: "file", text: "file-code" };

/** "1234" → "1,234". */
const grouped = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export default class QuickOpen {
  constructor(name) {
    this.name = name;
  }

  init(p, cx) {
    const pr = p ?? hostProps() ?? {};
    this.props = pr;
    this.preview = pr.preview === true;
    this.root = typeof pr.root === "string" && pr.root ? pr.root : null;
    this.on = typeof pr.on === "string" && pr.on ? pr.on : null;
    this.space = typeof pr.space === "string" ? pr.space : null;
    this.widen = pr.widen === true;
    this.list = null;
    this.loading = false;
    this.error = null;
    this.matches = [];
    this.selected = 0;
    this.gen = 0;
    this.handle = cx.focus_handle();
    this.scroll = ScrollHandle.new();
    this.input = InputState.new({ placeholder: t("filetab.quickopen.placeholder") });
    this.inputFocus = trackFocus(this.input);
    this.input.on("change", (_e, cx) => {
      this.rank();
      cx.notify();
    });
    this.load(cx);
    cx.timer.after(0, () => this.input.focus());
  }

  /** Lists the files (again, after the widen toggle). */
  load(cx) {
    if (this.preview || !this.space) return;
    const gen = ++this.gen;
    this.loading = true;
    this.error = null;
    cx.spawn(async (cx) => {
      const r = await listFiles(this.root ?? (this.on ? "" : home()), { on: this.on, widen: this.widen });
      if (gen !== this.gen) return;
      this.loading = false;
      if (r.error) {
        this.list = null;
        this.error = r.error;
      } else this.list = r;
      this.rank();
      cx.notify();
    });
  }

  rank() {
    this.matches = this.list ? search(this.list, this.input.value()) : [];
    this.selected = 0;
    if (this.matches.length) this.scroll.scroll_to_item(0);
  }

  move(dir, cx) {
    if (!this.matches.length) return;
    this.selected = (this.selected + dir + this.matches.length) % this.matches.length;
    this.scroll.scroll_to_item(this.selected);
    cx.notify();
  }

  /** Opens a match: a preview tab, or a pinned one. */
  pick(index, pinned, cx) {
    const m = this.matches[index];
    if (!m || this.preview) return;
    const r = open(m.abs, { on: this.list?.on ?? this.on, space: this.space, ...(pinned ? { pin: true } : { preview: true }) });
    if (r && this.props.overlay) closeOverlay(this.props.overlay);
    else cx.notify();
  }

  toggleWiden(value, cx) {
    this.widen = value;
    this.load(cx);
    cx.notify();
  }

  key(e, cx) {
    switch (e.keystroke) {
      case "down":
      case "ctrl-n":
        return this.move(1, cx), true;
      case "up":
      case "ctrl-p":
        return this.move(-1, cx), true;
      case "enter":
        return this.pick(this.selected, false, cx), true;
      case "cmd-enter":
        return this.pick(this.selected, true, cx), true;
      default:
        return false;
    }
  }

  close() {
    this.gen += 1;
    this.scroll.release();
    this.input.release();
    this.handle.release?.();
  }

  // Drawing.

  /** A path with the matched characters in the accent. */
  marked(text, from, positions, k, o) {
    const hit = new Set(positions.filter((i) => i >= from && i < from + text.length).map((i) => i - from));
    const runs = [];
    for (let i = 0; i < text.length; i++) {
      const on = hit.has(i);
      const last = runs[runs.length - 1];
      if (last && last.on === on) last.text += text[i];
      else runs.push({ on, text: text[i] });
    }
    return h_flex()
      .min_w(0)
      .overflow_hidden()
      .when(Boolean(o.flex), (e) => e.flex_1())
      .when(!o.flex, (e) => e.flex_none().max_w(o.max ?? 320))
      .children(
        runs.map((r) =>
          div()
            .flex_none()
            .whitespace_nowrap()
            .text_color(r.on ? k.accent : o.color)
            .when(r.on || Boolean(o.weight), (e) => e.font_weight(r.on ? k.weight.semibold : o.weight))
            .child(r.text),
        ),
      );
  }

  row(m, i, k) {
    const selected = i === this.selected;
    const cut = m.path.lastIndexOf("/") + 1;
    const name = m.path.slice(cut);
    const dir = cut > 0 ? m.path.slice(0, cut - 1) : "";
    return h_flex()
      .id(`qo-${i}`)
      .flex_none()
      .w_full()
      .min_w(0)
      .h(30)
      .px(10)
      .gap(8)
      .items_center()
      .rounded(k.radius.md)
      .role("list_box_option")
      .aria_selected(selected)
      .accessibility_label(m.path)
      .when(selected, (e) => e.bg(k.bg.selected))
      .cursor_pointer()
      .hover((s) => s.bg(selected ? k.bg.selected : k.bg.hover))
      .on_click((e, cx) => this.pick(i, Boolean(e.modifiers?.platform), cx))
      .child(Icon(KIND_ICON[kindOf(name)] ?? "file", { size: 14, color: selected ? k.text.primary : k.text.tertiary }))
      .child(this.marked(name, cut, m.positions, k, { color: k.text.primary, weight: selected ? k.weight.medium : undefined, max: 300 }))
      .child(
        div()
          .flex_1()
          .min_w(0)
          .text_size(k.fontSize.sm)
          .child(dir ? this.marked(dir, 0, m.positions, k, { color: k.text.tertiary, flex: true }) : ""),
      )
      .when(selected, (e) => e.child(Kbd("↩")));
  }

  body(k) {
    if (this.preview || !this.space) {
      return Empty({ id: "qo-no-place", icon: "folder", title: t("filetab.quickopen.no-place") });
    }
    if (this.loading && !this.list) {
      return v_flex()
        .flex_1()
        .items_center()
        .justify_center()
        .gap(10)
        .role("status")
        .child(Spinner({ size: 16 }))
        .child(Text(t("filetab.quickopen.loading"), { size: "sm", tone: "secondary" }));
    }
    if (this.error) {
      return Empty({ id: "qo-error", icon: "triangle-alert", title: t("filetab.quickopen.unreadable", { root: tilde(this.root ?? "~", home()) }) });
    }
    if (!this.matches.length) {
      const none = !this.list?.files?.length;
      return Empty({ id: "qo-empty", icon: "search", title: t(none ? "filetab.quickopen.no-files" : "filetab.quickopen.empty") });
    }
    return v_flex()
      .id("qo-list")
      .flex_1()
      .min_h(0)
      .overflow_y_scrollbar()
      .track_scroll(this.scroll)
      .px(6)
      .py(4)
      .gap(1)
      .role("list_box")
      .children(this.matches.map((m, i) => this.row(m, i, k)));
  }

  footer(k) {
    const list = this.list;
    const where = list ? tilde(list.root, home()) : this.root ? tilde(this.root, home()) : "";
    const count = list ? t(list.truncated ? "filetab.quickopen.truncated" : "filetab.quickopen.count", { count: grouped(list.files.length) }) : "";
    return h_flex()
      .flex_none()
      .h(36)
      .px(12)
      .gap(12)
      .items_center()
      .border_t(1)
      .border_color(k.line.soft)
      .bg(k.bg.surface)
      .child(
        div()
          .id("qo-widen-wrap")
          .flex_none()
          .tooltip(t("filetab.quickopen.widen-hint"))
          .child(
            CheckBox("qo-widen", this.widen, (value, cx) => this.toggleWiden(value, cx), {
              label: t("filetab.quickopen.widen"),
              disabled: this.preview || !this.space,
            }),
          ),
      )
      .child(Text(where ? `${where}${this.on ? ` · ${this.on}` : ""}` : "", { size: "xs", tone: "tertiary", mono: true, truncate: true }).flex_1())
      .when(Boolean(count), (e) => e.child(Text(count, { size: "xs", tone: "tertiary", nowrap: true })))
      .child(
        h_flex()
          .flex_none()
          .gap(6)
          .items_center()
          .child(Kbd("↩"))
          .child(Text(t("filetab.quickopen.open-preview"), { size: "xs", tone: "secondary", nowrap: true }))
          .child(Kbd("⌘↩"))
          .child(Text(t("filetab.quickopen.open-pinned"), { size: "xs", tone: "secondary", nowrap: true })),
      );
  }

  render(_cx) {
    const k = tokens();
    return ViewRoot("quickopen", { bg: k.bg.popover })
      .track_focus(this.handle)
      .role("dialog")
      .accessibility_label(t("filetab.quickopen.title"))
      .on_key_down((e, cx) => {
        if (this.key(e, cx)) cx.stop_propagation();
      })
      .child(
        h_flex()
          .flex_none()
          .p(10)
          .gap(8)
          .items_center()
          .border_b(1)
          .border_color(k.line.soft)
          .child(TextInput(this.input, { id: "qo-input", focused: this.inputFocus.focused, icon: "search", a11y: t("filetab.quickopen.title") }).h(32))
          .when(this.loading && Boolean(this.list), (e) => e.child(Spinner({ size: 14, label: t("filetab.quickopen.loading") }))),
      )
      .child(v_flex().flex_1().min_h(0).child(this.body(k)))
      .child(this.footer(k));
  }
}
