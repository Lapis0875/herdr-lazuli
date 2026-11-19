// The To-do app (DESIGN A3 To-do, ARCHITECTURE §4.5): data/lazuli/todo.md through sys/todo.js. Add, edit, check,
// reorder (up, down, to the top), delete several at once, undo; links in an item (URL, owner/repo#n, #n of the shown
// space's repo) open; the done ones fold away. Everything works from the keyboard:
//   j/k move · a add · ⏎/e edit · x/space check · ⇧J/⇧K move it · t to the top · v mark · ⇧D delete · o open link ·
//   u undo · z show done · / filter · esc clear.
// Every edit names its item by the store's `key`, which tells items with equal text apart (which occurrence it is), so
// an edit never lands on a twin. Notes and errors of sys/todo.js are named through `todo.note.*` and `todo.error.*`.

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState } from "gpui-base";
import { props, exec } from "herdr";
import { t } from "../core/i18n.js";
import * as todo from "../sys/todo.js";
import { tokens, withAlpha } from "../ui/tokens.js";
import { ViewRoot, Text, Icon, Button, IconButton, CheckBox, TextInput, Empty, Badge, Kbd, Spacer, trackFocus } from "../ui/kit.js";
import { Notice, Bar, pressFocus, inField } from "./apps/ui.js";
import { selectedIn, selectIn, revealIn } from "./apps/nav.js";
import { linkParts } from "./apps/fmt.js";

const ADDER = Object.freeze({ kind: "adder" });
const FOLD = Object.freeze({ kind: "fold" });
const list = (v) => (Array.isArray(v) ? v : []);

/** The list's keys (the header comment lists them), each to what it does on the view `v`. */
const KEYS = {
  j: (v) => v.selectAt(v.at() + 1),
  k: (v) => v.selectAt(v.at() - 1),
  g: (v) => v.selectAt(0),
  "shift-g": (v) => v.selectAt(v.stops().length - 1),
  a: (v, cx) => v.startEdit(cx),
  e: (v, cx) => (v.sel.kind === "fold" ? v.fold(cx) : v.startEdit(cx, v.selected()?.key)),
  x: (v, cx) => (v.sel.kind === "fold" ? v.fold(cx) : v.toggle(cx)),
  "shift-j": (v, cx) => v.move(cx, 1),
  "shift-k": (v, cx) => v.move(cx, -1),
  t: (v, cx) => v.top(cx),
  "shift-d": (v, cx) => v.remove(cx),
  v: (v, cx) => v.mark(cx),
  o: (v, cx) => v.openLink(cx),
  u: (v, cx) => v.undo(cx),
  z: (v, cx) => v.fold(cx),
  "/": (v) => v.search.focus(),
  escape: (v) => (v.marks.size ? v.marks.clear() : v.search.set_value("")),
};
const KEY_ALIASES = { down: "j", up: "k", home: "g", end: "shift-g", enter: "e", space: "x", delete: "shift-d", "cmd-z": "u" };

export default class Todo {
  constructor(name) {
    this.name = name;
  }

  init(_p, cx) {
    this.live = props()?.preview !== true;
    this.sel = ADDER;
    this.seenShared = selectedIn("todo");
    // The link request last handled (nav.js revealIn): 0, so the one that opened this copy is shown too.
    this.seenReveal = 0;
    this.showDone = false;
    this.marks = new Set();
    this.editing = null;
    this.hover = null;
    this.notice = new Notice();
    this.handle = cx.focus_handle();
    this.editor = InputState.new({ placeholder: t("todo.placeholder") });
    this.editorFocus = trackFocus(this.editor);
    this.editor.on("submit", (_e, cx) => this.commit(cx));
    this.search = InputState.new({ placeholder: t("todo.filter") });
    this.searchFocus = trackFocus(this.search);
    this.search.on("change", (_e, cx) => cx.notify());
    this.search.on("submit", (_e, cx) => (this.handle.focus(), cx.notify()));
    if (this.seenShared) this.sel = { kind: "item", key: this.seenShared };
  }

  focus(_cx) {
    this.handle.focus();
  }

  // The model.

  model() {
    return todo.get();
  }

  items() {
    return list(this.model()?.items);
  }

  matches(item) {
    const words = this.search.value().toLowerCase().split(/\s+/).filter(Boolean);
    return words.every((w) => item.text.toLowerCase().includes(w));
  }

  shown() {
    const all = this.items().filter((i) => this.matches(i));
    return { open: all.filter((i) => !i.done), done: all.filter((i) => i.done) };
  }

  /** Whether the done ones show: asked for, or a filter is typed. */
  unfolded() {
    return this.showDone || this.search.value().trim() !== "";
  }

  /** What the selection can stop on, in order. */
  stops() {
    const { open, done } = this.shown();
    const out = [ADDER, ...open.map((i) => ({ kind: "item", key: i.key }))];
    if (done.length) out.push(FOLD);
    if (done.length && this.unfolded()) out.push(...done.map((i) => ({ kind: "item", key: i.key })));
    return out;
  }

  at() {
    return this.stops().findIndex((s) => s.kind === this.sel.kind && s.key === this.sel.key);
  }

  selectAt(i) {
    const all = this.stops();
    if (!all.length) return;
    const stop = all[Math.max(0, Math.min(all.length - 1, i))];
    const it = stop.kind === "item" ? this.item(stop.key) : null;
    this.sel = it ? this.pickOf(it) : stop;
    if (it) this.share(it.key);
  }

  share(key) {
    this.seenShared = key;
    selectIn("todo", key);
  }

  item(key) {
    return this.items().find((i) => i.key === key) ?? null;
  }

  /** A selection of an item: its key (which tells equal texts apart), and its line and text to find it again when an
   *  edit changed the key. */
  pickOf(it) {
    return { kind: "item", key: it.key, line: it.line, text: it.undated };
  }

  /** After an edit the selected key may name nothing (a new text, a done date, a count of equal texts that changed):
   *  the selection follows the item to its line and text, else to the first item with that text. */
  follow() {
    const s = this.sel;
    if (s.kind !== "item" || this.item(s.key) || typeof s.text !== "string") return;
    const all = this.items();
    const it = all.find((i) => i.line === s.line && i.undated === s.text) ?? all.find((i) => i.undated === s.text);
    if (it) this.sel = this.pickOf(it);
  }

  selected() {
    return this.sel.kind === "item" ? this.item(this.sel.key) : null;
  }

  /** Marks and the selection hold only rows shown (a filter or the folded done ones hide the others): a check or a
   *  delete never reaches a row the person cannot see. Run on every draw. */
  reconcile() {
    const shown = new Set(this.stops().filter((s) => s.kind === "item").map((s) => s.key));
    for (const key of [...this.marks]) if (!shown.has(key)) this.marks.delete(key);
    if (this.sel.kind === "item" && !this.editing && this.item(this.sel.key) && !shown.has(this.sel.key)) this.sel = ADDER;
  }

  /** The marked items, else the selected one: rows shown only (see reconcile). */
  targets() {
    if (this.marks.size) return this.items().filter((i) => this.marks.has(i.key)).map((i) => i.key);
    const it = this.selected();
    return it ? [it.key] : [];
  }

  // Actions.

  act(cx, job, { after, failed } = {}) {
    if (!this.live) return;
    cx.spawn(async (cx) => {
      const r = await job();
      if (r.error) {
        this.notice.show(cx, { tone: "error", text: t(`todo.error.${r.error}`) });
        failed?.(r, cx);
      } else if (after) after(r, cx);
      else if (r.note && r.note !== "added" && r.note !== "toggled") this.notice.show(cx, { tone: r.note === "undone" ? "success" : "info", text: t(`todo.note.${r.note}`) });
      cx.notify();
    });
  }

  startEdit(cx, key) {
    if (!this.live) return;
    const it = key ? this.item(key) : null;
    // What the edit started from: the item's key (this very occurrence) and its text, kept even if it changes later.
    this.editing = it ? { key: it.key, from: it.text, done: it.done, doneOn: it.doneOn } : {};
    this.sel = it ? this.pickOf(it) : ADDER;
    this.editor.set_value(it ? it.undated ?? "" : "");
    this.editor.focus();
    cx.notify();
  }

  commit(cx) {
    const e = this.editing;
    if (!e) return;
    const text = this.editor.value().trim();
    this.editing = null;
    this.handle.focus();
    if (e.key) {
      // An edit always names the item it began on, even when it vanished or changed meanwhile: sys/todo.js then
      // refuses (`not-found`, `changed`) and the typed text comes back in the field to add or drop, never lost and
      // never added on its own. An item done keeps its date: the text edited is the one without it.
      const to = e.done && e.doneOn ? `${text} (done ${e.doneOn})` : text;
      if (text && to !== e.from) {
        this.sel = { kind: "item", key: to, line: this.item(e.key)?.line, text };
        this.act(cx, () => todo.edit(e.key, to), {
          failed: (r, cx) => {
            this.editing = {};
            this.sel = ADDER;
            this.editor.set_value(text);
            this.editor.focus();
            this.notice.show(cx, { tone: "error", text: t(`todo.error.${r.error}`), body: t("todo.draftKept") });
            cx.notify();
          },
        });
      }
    } else if (text) {
      // A new item goes on top: the first one with its text.
      this.sel = { kind: "item", key: text, text };
      this.act(cx, () => todo.add(text));
    }
    cx.notify();
  }

  cancel(cx) {
    this.editing = null;
    this.handle.focus();
    cx.notify();
  }

  toggle(cx, keys = this.targets()) {
    if (!keys.length) return;
    this.marks.clear();
    this.act(cx, () => todo.toggle(keys));
  }

  remove(cx, keys = this.targets()) {
    if (!keys.length) return;
    this.marks.clear();
    const n = keys.length;
    // Named before it goes: the list no longer has it once the notice shows.
    const name = this.item(keys[0])?.undated ?? keys[0];
    this.act(cx, () => todo.remove(keys), {
      after: (_r, cx) =>
        this.notice.show(cx, {
          tone: "success",
          text: n === 1 ? t("todo.deletedOne") : t("todo.deletedMany", { n }),
          body: n === 1 ? name : undefined,
          action: { label: t("todo.undo"), onClick: (_e, cx) => this.undo(cx) },
        }),
    });
  }

  move(cx, by) {
    const it = this.selected();
    if (!it || it.done || this.marks.size) return;
    this.act(cx, () => todo.move(it.key, by));
  }

  top(cx) {
    const it = this.selected();
    if (!it || it.done) return;
    this.act(cx, () => todo.place(it.key, 0));
  }

  undo(cx) {
    this.act(cx, () => todo.undo());
  }

  openLink(cx, link) {
    const target = link ?? this.selected()?.links?.[0];
    if (target?.url && this.live) exec("open", [target.url]).catch(() => {});
    cx.notify();
  }

  mark(cx) {
    const it = this.selected();
    if (!it) return;
    if (!this.marks.delete(it.key)) this.marks.add(it.key);
    this.selectAt(this.at() + 1);
    cx.notify();
  }

  fold(cx) {
    this.showDone = !this.showDone;
    if (!this.unfolded() && this.selected()?.done) this.sel = FOLD;
    cx.notify();
  }

  pick(cx, item) {
    this.sel = this.pickOf(item);
    this.share(item.key);
    // A row's own buttons start an edit before the row sees the press: the editor keeps the keyboard then.
    if (!this.editing) this.handle.focus();
    cx.notify();
  }

  // Keys.

  key(e, cx) {
    const k = e.keystroke;
    if (this.editing) {
      if (k === "escape") this.cancel(cx);
      return k === "escape";
    }
    if (this.searchFocus.focused) {
      if (k === "escape") {
        this.search.set_value("");
        this.handle.focus();
        cx.notify();
        return true;
      }
      if (k === "down") {
        this.handle.focus();
        return true;
      }
      return false;
    }
    const act = KEYS[KEY_ALIASES[k] ?? k];
    if (!act) return false;
    act(this, cx);
    return true;
  }

  // Drawing.

  textOf(item) {
    const k = tokens();
    const shown = item.done ? item.undated : item.text;
    return h_flex()
      .flex_1()
      .min_w(0)
      .items_center()
      .overflow_hidden()
      .whitespace_nowrap()
      .text_color(item.done ? k.text.secondary : k.text.primary)
      .when(item.done, (e) => e.line_through())
      .children(
        linkParts(shown, list(item.links)).map((p, i) =>
          p.link
            ? h_flex()
                .id(`td-link-${item.line}-${i}`)
                .flex_none()
                .gap(3)
                .items_center()
                .text_color(item.done ? k.text.secondary : k.accent)
                .cursor_pointer()
                .hover((s) => s.underline())
                .tooltip(p.link.url)
                .on_click((_e, cx) => {
                  cx.stop_propagation();
                  this.openLink(cx, p.link);
                })
                .when(p.link.kind === "url", (e) => e.child(Icon("link", { size: 12 })))
                .child(p.link.kind === "url" ? p.text.replace(/^https?:\/\//, "").slice(0, 48) : p.text)
            : div().flex_none().child(p.text),
        ),
      );
  }

  itemRow(item, index, openCount) {
    const k = tokens();
    const on = this.sel.kind === "item" && this.sel.key === item.key;
    const marked = this.marks.has(item.key);
    const id = `td-${item.line}`;
    if (this.editing?.key === item.key) {
      return h_flex().id(id).h(36).px(10).gap(10).items_center().child(CheckBox(`${id}-c`, item.done, () => {}, { disabled: true })).child(inField(this, TextInput(this.editor, { id: `${id}-edit`, focused: this.editorFocus.focused, a11y: t("todo.editLabel") }))).child(Kbd("⏎"));
    }
    const showActs = on || this.hover === item.key;
    const link = item.links?.[0];
    return h_flex()
      .id(id)
      .h(36)
      .px(10)
      .gap(10)
      .items_center()
      .rounded(k.radius.md)
      .role("list_item")
      .aria_selected(on)
      .bg(on ? k.bg.selected : marked ? withAlpha(k.accent, 0.1) : k.bg.card)
      .hover((s) => s.bg(on ? k.bg.selected : k.bg.hover))
      .cursor_pointer()
      .on_hover((h, cx) => {
        const next = h ? item.key : this.hover === item.key ? null : this.hover;
        if (next !== this.hover) {
          this.hover = next;
          cx.notify();
        }
      })
      .on_click((e, cx) => (e.click_count > 1 ? this.startEdit(cx, item.key) : this.pick(cx, item)))
      .child(CheckBox(`${id}-c`, item.done, (_v, cx) => this.toggle(cx, [item.key]), { disabled: !this.live }).accessibility_label(item.done ? t("todo.reopenItem", { text: item.undated }) : t("todo.doneItem", { text: item.undated })))
      .when(marked, (e) => e.child(Icon("check", { size: 12, color: k.accent })))
      .child(this.textOf(item))
      .when(item.done && Boolean(item.doneOn), (e) => e.child(Badge(item.doneOn, { mono: true })))
      .when(showActs && this.live, (e) =>
        e.child(
          h_flex()
            .flex_none()
            .gap(2)
            .when(Boolean(link), (e2) => e2.child(IconButton(`${id}-open`, "external", t("todo.openLink", { link: link?.label ?? "" }), { onClick: (_e, cx) => this.openLink(cx, link) })))
            .child(IconButton(`${id}-edit-btn`, "pencil", t("todo.edit"), { onClick: (_e, cx) => this.startEdit(cx, item.key) }))
            .when(!item.done, (e2) =>
              e2
                .child(IconButton(`${id}-top`, "arrow-up-to-line", t("todo.top"), { disabled: index === 0, onClick: (_e, cx) => (this.pick(cx, item), this.top(cx)) }))
                .child(IconButton(`${id}-up`, "arrow-up", t("todo.up"), { disabled: index === 0, onClick: (_e, cx) => (this.pick(cx, item), this.move(cx, -1)) }))
                .child(IconButton(`${id}-down`, "arrow-down", t("todo.down"), { disabled: index >= openCount - 1, onClick: (_e, cx) => (this.pick(cx, item), this.move(cx, 1)) })),
            )
            .child(IconButton(`${id}-rm`, "trash-2", t("todo.delete"), { onClick: (_e, cx) => this.remove(cx, [item.key]) })),
        ),
      );
  }

  rows() {
    const k = tokens();
    const { open, done } = this.shown();
    const out = [];
    const adderOn = this.sel.kind === "adder";
    out.push(
      this.editing && !this.editing.key
        ? h_flex().id("td-adder").h(36).px(10).gap(10).items_center().child(Icon("plus", { size: 14, color: k.text.secondary })).child(inField(this, TextInput(this.editor, { id: "td-add", focused: this.editorFocus.focused, a11y: t("todo.addLabel") }))).child(Kbd("⏎"))
        : h_flex()
            .id("td-adder")
            .h(36)
            .px(10)
            .gap(10)
            .items_center()
            .rounded(k.radius.md)
            .bg(adderOn ? k.bg.selected : k.bg.card)
            .hover((s) => s.bg(adderOn ? k.bg.selected : k.bg.hover))
            .cursor_pointer()
            .text_color(k.text.secondary)
            .on_click((_e, cx) => this.startEdit(cx))
            .child(Icon("plus", { size: 14 }))
            .child(Text(t("todo.add"), { tone: "secondary" }).flex_1())
            .child(Kbd("A")),
    );
    open.forEach((it, i) => out.push(this.itemRow(it, i, open.length)));
    if (done.length) {
      const unfolded = this.unfolded();
      const on = this.sel.kind === "fold";
      out.push(
        h_flex()
          .id("td-fold")
          .h(32)
          .mt(4)
          .px(10)
          .gap(8)
          .items_center()
          .rounded(k.radius.md)
          .bg(on ? k.bg.selected : k.bg.card)
          .hover((s) => s.bg(on ? k.bg.selected : k.bg.hover))
          .cursor_pointer()
          .on_click((_e, cx) => ((this.sel = FOLD), this.fold(cx)))
          .child(Icon(unfolded ? "chevron-down" : "chevron-right", { size: 14, color: k.text.secondary }))
          .child(Text(t("todo.doneCount", { n: done.length }), { size: "sm", tone: "secondary", weight: "medium" }).flex_1())
          .child(Kbd("Z")),
      );
      if (unfolded) done.forEach((it, i) => out.push(this.itemRow(it, i, 0)));
    }
    return out;
  }

  /** The selection's actions, as the bar under the list shows them. */
  actions() {
    if (!this.live) return [];
    if (this.marks.size) {
      const n = this.targets().length;
      return [
        { id: "toggle", label: t("todo.toggleN", { n }), kbd: "X", icon: "check", variant: "primary", run: (cx) => this.toggle(cx) },
        { id: "delete", label: t("todo.deleteN", { n }), kbd: "⇧D", icon: "trash-2", run: (cx) => this.remove(cx) },
        { id: "unmark", label: t("todo.unmark"), kbd: "esc", variant: "ghost", run: (cx) => (this.marks.clear(), cx.notify()) },
      ];
    }
    const it = this.selected();
    if (!it) return [{ id: "add", label: t("todo.add"), kbd: "A", icon: "plus", variant: "primary", run: (cx) => this.startEdit(cx) }];
    const link = it.links?.[0];
    return [
      { id: "toggle", label: it.done ? t("todo.reopen") : t("todo.done"), kbd: "X", icon: it.done ? "undo" : "check", variant: "primary", run: (cx) => this.toggle(cx) },
      { id: "edit", label: t("todo.edit"), kbd: "E", icon: "pencil", run: (cx) => this.startEdit(cx, it.key) },
      ...(link ? [{ id: "open", label: t("todo.openLink", { link: link.label }), kbd: "O", icon: "external", run: (cx) => this.openLink(cx, link) }] : []),
      ...(!it.done ? [{ id: "up", label: t("todo.up"), kbd: "⇧K", icon: "arrow-up", variant: "ghost", run: (cx) => this.move(cx, -1) }, { id: "down", label: t("todo.down"), kbd: "⇧J", icon: "arrow-down", variant: "ghost", run: (cx) => this.move(cx, 1) }] : []),
      { id: "mark", label: t("todo.mark"), kbd: "V", variant: "ghost", run: (cx) => this.mark(cx) },
      { id: "delete", label: t("todo.delete"), kbd: "⇧D", icon: "trash-2", variant: "ghost", run: (cx) => this.remove(cx) },
    ];
  }

  body() {
    const m = this.model();
    if (!m) return Empty({ id: "td-loading", icon: "list-todo", title: t("common.loading") });
    if (!this.items().length && !this.editing) {
      return Empty({ id: "td-empty", icon: "list-todo", title: t("todo.empty"), body: t("todo.emptyBody"), action: this.live ? Button("td-empty-add", t("todo.add"), { icon: "plus", kbd: "A", variant: "primary", onClick: (_e, cx) => this.startEdit(cx) }) : null });
    }
    const { open, done } = this.shown();
    if (this.search.value().trim() && !open.length && !done.length) return Empty({ id: "td-nomatch", icon: "search", title: t("todo.noMatch"), body: t("todo.noMatchBody", { query: this.search.value().trim() }) });
    return v_flex().id("td-list").gap(1).role("list").accessibility_label(t("todo.title")).children(this.rows());
  }

  render(_cx) {
    const k = tokens();
    const m = this.model();
    // The selected item followed through edits that changed its key; a row picked elsewhere (Home) becomes the
    // selection.
    this.follow();
    const wanted = selectedIn("todo");
    if (wanted && wanted !== this.seenShared) {
      this.seenShared = wanted;
      const it = this.item(wanted);
      if (it) this.sel = this.pickOf(it);
    }
    // A link followed from Home shows its item: the done ones unfolded, a filter that hides it cleared.
    const req = revealIn("todo");
    const linked = req && req.n !== this.seenReveal ? this.item(req.key) : null;
    if (linked) {
      this.seenReveal = req.n;
      this.sel = this.pickOf(linked);
      if (linked.done) this.showDone = true;
      if (!this.matches(linked)) this.search.set_value("");
    }
    this.reconcile();
    const total = (m?.open ?? 0) + (m?.done ?? 0);
    const banner = this.notice.render("td-notice", t("common.close"));
    const acts = this.actions();
    return ViewRoot("lz-todo", { bg: k.bg.card })
      .track_focus(this.handle)
      .on_mouse_down("left", pressFocus(this, () => Boolean(this.editing)))
      .on_key_down((e, cx) => {
        if (this.key(e, cx)) {
          cx.stop_propagation();
          cx.notify();
        }
      })
      .child(
        h_flex()
          .flex_none()
          .px(22)
          .pt(16)
          .pb(10)
          .gap(12)
          .items_center()
          .child(Icon("list-todo", { size: 18, color: k.text.secondary }))
          .child(Text(t("todo.title"), { size: "xl", weight: "semibold", nowrap: true }))
          .child(Text(m ? (m.open ? t("todo.summary", { open: m.open, done: m.done }) : m.done ? t("todo.summaryAllDone", { done: m.done }) : t("todo.summaryEmpty")) : "", { tone: "secondary", nowrap: true }))
          .when(total > 0, (e) => e.child(div().w(120).child(Bar((m.done ?? 0) / total, { color: k.state.done }))))
          .child(Spacer())
          .child(IconButton("td-undo", "undo", t("todo.undoKey"), { disabled: !this.live || !m?.canUndo, onClick: (_e, cx) => this.undo(cx) }))
          .child(Button("td-add-btn", t("todo.add"), { variant: "primary", icon: "plus", kbd: "A", disabled: !this.live, onClick: (_e, cx) => this.startEdit(cx) })),
      )
      .child(
        h_flex()
          .flex_none()
          .px(22)
          .pb(10)
          .gap(8)
          .items_center()
          .child(div().flex_1().max_w(420).child(inField(this, TextInput(this.search, { id: "td-search", focused: this.searchFocus.focused, icon: "search", a11y: t("todo.filter") }))))
          .when(this.marks.size > 0, (e) => e.child(Badge(t("todo.marked", { n: this.marks.size }), { tone: "accent" })))
          .child(Spacer())
          .child(Button("td-fold-btn", this.unfolded() ? t("todo.hideDone") : t("todo.showDone"), { size: "sm", icon: this.unfolded() ? "eye-off" : "eye", kbd: "Z", onClick: (_e, cx) => this.fold(cx) })),
      )
      .when(m?.error === "read-failed", (e) => e.child(div().px(22).pb(8).child(Text(t("todo.error.read-failed"), { size: "sm", tone: "error" }).role("alert"))))
      .child(v_flex().id("td-scroll").flex_1().min_h(0).px(12).overflow_y_scrollbar().child(this.body()))
      .when(Boolean(banner), (e) => e.child(div().flex_none().px(22).pt(8).child(banner)))
      .child(
        h_flex()
          .flex_none()
          .px(22)
          .py(10)
          .gap(6)
          .flex_wrap()
          .items_center()
          .border_t(1)
          .border_color(k.line.soft)
          .bg(k.bg.surface)
          .children(acts.map((a) => Button(`td-act-${a.id}`, a.label, { size: "sm", icon: a.icon, kbd: a.kbd, variant: a.variant ?? "secondary", onClick: (_e, cx) => a.run(cx) })))
          .child(Spacer())
          .child(Text(t("todo.keys"), { size: "xs", tone: "tertiary", nowrap: true })),
      );
  }
}
