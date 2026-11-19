// The palette (⇧⌘P, ARCHITECTURE §2, §4.4): a dialog over the window that searches sys/search.js (lazuli's and
// Herdr's commands with their keys, layouts, the language, spaces, tabs, agents, PRs, to-dos, routines and past
// sessions) plus lazuli's settings, and runs the picked result's action descriptor. With no text it lists the sources
// by group; typed text ranks them, matched letters in the accent color. ↑/↓ (⌃P/⌃N), ⇞/⇟ move; Enter runs; ⌘Enter
// runs the alternate action (a past session forks instead of resuming); Esc closes. ⇧⌘P again closes it too.

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState, ScrollHandle } from "gpui-base";
import { closeOverlay, props } from "herdr";
import * as search from "../sys/search.js";
import { t } from "../core/i18n.js";
import { tokens } from "../ui/tokens.js";
import { ViewRoot, Text, Icon, Kbd, StatusDot, TextInput, trackFocus, Empty, Spacer } from "../ui/kit.js";
import { openSettings, paletteClosed, paletteOpened } from "./shell/actions.js";
import { chord } from "./shell/format.js";

const log = (msg) => console.log(`[lazuli/palette] ${msg}`);
const errText = (e) => e?.message ?? String(e);

const LIMIT = 80;
const PAGE = 8;
const ROW = 32;

// search.js icon names → ui/icons/ files.
const ICONS = new Set([
  "command", "terminal", "layout-template", "folder", "app-window", "bot", "git-pull-request", "circle-check", "circle",
  "clock", "message-square", "languages", "settings",
]);
const ICON_ALIAS = { layout: "layout-template", message: "message-square" };
const iconOf = (name) => {
  const n = ICON_ALIAS[name] ?? name;
  return ICONS.has(n) ? n : "command";
};

/** lazuli's own palette entries that sys/search.js does not list. */
function extras() {
  return [
    {
      id: "shell:settings",
      kind: "settings",
      group: "lazuli",
      icon: "settings",
      title: t("palette.cmd.settings"),
      hint: t("palette.cmd.settingsHint"),
      keys: null,
      words: "settings preferences 설정 환경설정 language 언어 notifications 알림",
      action: { kind: "settings" },
    },
  ];
}

/** Whether every letter of `q` appears in order in `text`, the run kept close (a loose match is noise). */
function looseMatch(q, text) {
  const s = text.toLowerCase();
  let at = 0;
  let first = -1;
  for (const ch of q) {
    const i = s.indexOf(ch, at);
    if (i < 0) return false;
    if (first < 0) first = i;
    at = i + 1;
  }
  return at - first <= q.length * 3;
}

export default class Palette {
  constructor(name) {
    this.name = name;
  }

  init(p, cx) {
    this.props = props() ?? p ?? {};
    this.at = 0;
    this.busy = false;
    this.scroll = ScrollHandle.new();
    this.input = InputState.new({ placeholder: t("palette.placeholder") });
    this.focus = trackFocus(this.input);
    this.input.on("change", (_e, cx) => {
      this.at = 0;
      this.scroll.scroll_to_item(0);
      search.refresh(cx, this.input.value());
      cx.notify();
    });
    this.input.on("submit", (e, cx) => this.pick(Boolean(e?.secondary), cx));
    this.input.focus();
    // The dialog takes the keyboard a moment after it opens; ask again then.
    cx.timer.after(300, () => this.input.focus());
    paletteOpened(this.props.overlay);
    search.refresh(cx, "");
  }

  async close() {
    paletteClosed(this.props.overlay);
    this.input?.release();
    this.scroll?.release();
  }

  dismiss() {
    const id = props()?.overlay ?? this.props.overlay;
    paletteClosed(id);
    if (id) closeOverlay(id);
  }

  /** The rows for the typed text: lazuli's extras first when they match, then sys/search.js's ranked results. */
  results(text) {
    const q = String(text ?? "").trim().toLowerCase().replace(/\s+/g, "");
    const own = extras().filter((e) => !q || looseMatch(q, e.title) || `${e.title} ${e.words}`.toLowerCase().includes(q));
    let found = [];
    try {
      found = search.query(text, { limit: LIMIT });
    } catch (e) {
      log(`query failed: ${errText(e)}`);
    }
    return [...own.map((e) => ({ ...e, score: 0, positions: [] })), ...found];
  }

  /** Runs the picked row (`alt`: its alternate action), then closes. A settings change or a browser open finishes
   *  before the dialog goes. */
  pick(alt, cx) {
    if (this.busy || props()?.preview === true) return;
    const e = this.results(this.input.value())[this.at];
    if (!e) return;
    const action = alt ? (e.alt ?? null) : e.action;
    if (!action) return;
    if (action.kind === "settings") {
      this.dismiss();
      openSettings();
      return;
    }
    this.busy = true;
    cx.spawn(async () => {
      try {
        await search.perform(action);
      } catch (err) {
        log(`${action.kind} failed: ${errText(err)}`);
      }
      this.busy = false;
      this.dismiss();
    });
  }

  /** Moves the highlight to row `to` of `rows`, keeping it on screen: the list's children are the rows plus, with
   *  no text typed, one group heading before each group's first row. */
  move(to, rows) {
    if (!rows.length) return;
    this.at = Math.max(0, Math.min(rows.length - 1, to));
    let child = this.at;
    if (this.input.value().trim() === "") {
      let group = null;
      for (let i = 0; i <= this.at; i++) {
        if (rows[i].group !== group) {
          group = rows[i].group;
          child += 1;
        }
      }
    }
    this.scroll.scroll_to_item(child);
  }

  /** A key from the window or the `key:` test hook: true when the palette used it. */
  key(e, cx, typed = false) {
    const rows = this.results(this.input.value());
    const key = e.keystroke;
    if (key === "escape") this.dismiss();
    else if (key === "down" || key === "ctrl-n") this.move(this.at + 1, rows);
    else if (key === "up" || key === "ctrl-p") this.move(this.at - 1, rows);
    else if (key === "pagedown") this.move(this.at + PAGE, rows);
    else if (key === "pageup") this.move(this.at - PAGE, rows);
    // Enter in the search line is its submit; only a driven one (the test hook) comes here.
    else if ((key === "enter" || key === "cmd-enter") && !typed) this.pick(key === "cmd-enter", cx);
    else return false;
    return true;
  }

  /** The title with the matched letters in the accent color. */
  title(k, e, on) {
    const text = String(e.title ?? "");
    const hits = new Set(Array.isArray(e.positions) ? e.positions : []);
    if (!hits.size) return div().flex_shrink(1).min_w(0).truncate().text_color(k.text.primary).when(on, (x) => x.font_weight(k.weight.medium)).child(text);
    const parts = [];
    let run = "";
    let runHit = null;
    [...text].forEach((ch, i) => {
      const hit = hits.has(i);
      if (runHit !== null && hit !== runHit) {
        parts.push({ text: run, hit: runHit });
        run = "";
      }
      run += ch;
      runHit = hit;
    });
    if (run) parts.push({ text: run, hit: runHit });
    return h_flex()
      .flex_shrink(1)
      .min_w(0)
      .overflow_hidden()
      .children(parts.map((part) => div().flex_none().whitespace_nowrap().text_color(part.hit ? k.accent : k.text.primary).when(part.hit, (x) => x.font_weight(k.weight.semibold)).child(part.text)));
  }

  row(k, e, i, searching) {
    const on = i === this.at;
    const keys = e.keys ? chord(e.keys) : "";
    return h_flex()
      .id(`pal-${i}`)
      .flex_none()
      .w_full()
      .h(ROW)
      .px(10)
      .gap(10)
      .items_center()
      .rounded(k.radius.md)
      .cursor_pointer()
      .role("list_box_option")
      .aria_selected(on)
      .accessibility_label(e.hint ? `${e.title}, ${e.hint}` : String(e.title ?? ""))
      .when(on, (x) => x.bg(k.bg.selected))
      .when(!on, (x) => x.hover((s) => s.bg(k.bg.hover)))
      .on_click((_ev, cx) => {
        this.at = i;
        this.pick(false, cx);
      })
      .child(Icon(iconOf(e.icon), { size: 14, color: on ? k.accent : k.text.secondary }))
      .when(Boolean(e.status), (x) => x.child(StatusDot(e.status === "blocked" ? "blocked" : e.status, { size: 6 })))
      .child(this.title(k, e, on))
      .when(Boolean(e.hint), (x) => x.child(div().flex_1().min_w(0).truncate().text_size(k.fontSize.sm).text_color(k.text.tertiary).child(e.hint)))
      .when(!e.hint, (x) => x.child(Spacer()))
      .when(searching, (x) => x.child(Text(t(`palette.group.${e.group}`), { size: "xs", tone: "tertiary", nowrap: true })))
      .when(Boolean(keys), (x) => x.child(Kbd(keys)))
      .when(on && Boolean(e.alt), (x) => x.child(Kbd(`⌘↵ ${t("palette.alt.fork")}`, { tone: "accent" })));
  }

  render(_cx) {
    const k = tokens();
    const text = this.input.value();
    const searching = text.trim() !== "";
    const rows = this.results(text);
    if (this.at >= rows.length) this.at = Math.max(0, rows.length - 1);
    const children = [];
    let group = null;
    rows.forEach((e, i) => {
      if (!searching && e.group !== group) {
        group = e.group;
        children.push(
          div()
            .flex_none()
            .h(26)
            .px(10)
            .pt(8)
            .text_size(k.fontSize.xs)
            .font_weight(k.weight.medium)
            .text_color(k.text.tertiary)
            .child(t(`palette.group.${e.group}`)),
        );
      }
      children.push(this.row(k, e, i, searching));
    });
    const current = rows[this.at];
    return ViewRoot("lz-palette", { bg: k.bg.popover })
      .on_key_down((e, cx) => {
        if (!this.key(e, cx, true)) return;
        cx.stop_propagation();
        cx.notify();
      })
      .child(
        div()
          .flex_none()
          .p(10)
          .border_b(1)
          .border_color(k.line.soft)
          .child(TextInput(this.input, { id: "pal-input", focused: this.focus.focused, icon: "search", a11y: t("palette.placeholder") })),
      )
      .child(
        rows.length
          ? v_flex()
              .id("pal-list")
              .flex_1()
              .min_h(0)
              .p(6)
              .gap(1)
              .role("list_box")
              .accessibility_label(t("palette.label"))
              .overflow_y_scrollbar()
              .track_scroll(this.scroll)
              .children(children)
          : v_flex().flex_1().items_center().justify_center().child(Empty({ id: "pal-empty", icon: "search", title: t("palette.empty"), body: searching ? t("palette.emptyHint", { query: text.trim() }) : null })),
      )
      .child(
        h_flex()
          .flex_none()
          .h(30)
          .px(12)
          .gap(14)
          .items_center()
          .border_t(1)
          .border_color(k.line.soft)
          .text_size(k.fontSize.xs)
          .text_color(k.text.tertiary)
          .child(h_flex().gap(4).items_center().child(Kbd("↑↓")).child(t("palette.hint.move")))
          .child(h_flex().gap(4).items_center().child(Kbd("↵")).child(t("palette.hint.run")))
          .when(Boolean(current?.alt), (x) => x.child(h_flex().gap(4).items_center().child(Kbd("⌘↵")).child(t("palette.alt.fork"))))
          .child(Spacer())
          .child(h_flex().gap(4).items_center().child(Kbd("esc")).child(t("palette.hint.close"))),
      );
  }
}
