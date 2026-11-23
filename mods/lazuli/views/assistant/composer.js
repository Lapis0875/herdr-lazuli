// The chat's composer (D19, D20, D28, K7, A7, A8): the queued chips (removable; paused after Stop, with Resume), the
// attached files, the text, and a toolbar with @ and /, the key hint, Stop while a turn runs, and Send (Steer while
// running). Enter sends, or steers while a turn runs; ⇧Enter is a new line; ⌥Enter queues. Typing @ lists the
// folder's files (images excluded) and the pick becomes an attachment; / at the start lists the commands Hermes
// advertised, without /steer and /queue. The lists hang above the box in the window's top layer.

import { div } from "gpui-kit";
import { h_flex, v_flex, TextareaState, Textarea, Popup, Button as BaseButton } from "gpui-base";
import { t } from "../../core/i18n.js";
import { tokens } from "../../ui/tokens.js";
import { Text, Icon, IconButton, Button, Spacer, Menu, MenuLabel, trackFocus } from "../../ui/kit.js";
import { stopPress } from "../panels/common.js";
import { menuCommands } from "../../core/assistant-agents.js";

const MENU_ROWS = 8;
const stop = (_e, cx) => cx.stop_propagation();

export class Composer {
  /** `view` is the chat view: submit(cx, how), stop(cx), unqueue(cx, id), resumeQueue(cx). Made in `init`. */
  constructor(view) {
    this.view = view;
    this.box = TextareaState.new({});
    this.box.set_auto_grow(1, 8);
    this.focus = trackFocus(this.box);
    this.attachments = [];
    // The open list: `{kind: "mention" | "commands", query, start, end}`; `sel` its highlighted row; `closedFor` the
    // text Escape closed it for (it stays closed until the text changes).
    this.menu = null;
    this.sel = 0;
    this.closedFor = null;
    this.box.on("change", (_e, cx) => {
      this.read();
      cx.notify();
    });
  }

  value() {
    return this.box.value();
  }

  /** Sets the text and the attachments (a sample's seed, a cleared box after sending). */
  set(text = "", attachments = []) {
    this.box.set_value(text);
    this.attachments = [...attachments];
    this.closedFor = null;
    this.read();
  }

  attach(path) {
    if (path && !this.attachments.includes(path)) this.attachments.push(path);
  }

  /** Which list the text before the cursor asks for: / at the very start, or an @word being typed. */
  read() {
    const text = this.value();
    const range = this.box.selected_range();
    const cursor = Math.min(text.length, range?.end ?? text.length);
    const before = text.slice(0, cursor);
    const prev = this.menu;
    let next = null;
    const slash = /^\/(\S*)$/.exec(before);
    const at = /(^|\s)@([^\s@]*)$/.exec(before);
    if (slash) next = { kind: "commands", query: slash[1], start: 0, end: cursor };
    else if (at) next = { kind: "mention", query: at[2], start: cursor - at[2].length - 1, end: cursor };
    if (text === this.closedFor) next = null;
    else this.closedFor = null;
    if (!next || !prev || next.kind !== prev.kind || next.query !== prev.query) this.sel = 0;
    this.menu = next;
  }

  /** The open list's rows: files `{kind: "file", path}` or commands `{kind: "command", name, description}`. */
  rows(chat, files) {
    const m = this.menu;
    if (!m) return [];
    if (m.kind === "commands") {
      const q = m.query.toLowerCase();
      return menuCommands(chat?.commands, chat?.agent)
        .filter((c) => c.name.toLowerCase().startsWith(q))
        .map((c) => ({ kind: "command", name: c.name, description: c.description ?? "" }));
    }
    const q = m.query.toLowerCase();
    const base = (p) => p.slice(p.lastIndexOf("/") + 1).toLowerCase();
    return files
      .filter((p) => !q || p.toLowerCase().includes(q))
      .sort((a, b) => Number(!base(a).startsWith(q)) - Number(!base(b).startsWith(q)))
      .slice(0, MENU_ROWS)
      .map((path) => ({ kind: "file", path }));
  }

  /** Takes a row: a file joins the attachments and its @word leaves the text; a command replaces the /word. */
  pick(row) {
    const m = this.menu;
    if (!m || !row) return;
    const text = this.value();
    if (row.kind === "file") {
      this.attach(row.path);
      this.box.set_value(text.slice(0, m.start) + text.slice(m.end));
      this.box.set_selected_range({ start: m.start, end: m.start });
    } else {
      const head = `/${row.name} `;
      this.box.set_value(head + text.slice(m.end));
      this.box.set_selected_range({ start: head.length, end: head.length });
    }
    this.menu = null;
    this.box.focus();
  }

  /** Types a trigger character at the cursor (the toolbar's @ and /) and opens its list. */
  insert(ch) {
    if (ch === "/" && this.value() !== "") return this.box.focus();
    this.box.replace(ch);
    this.box.focus();
    this.read();
  }

  /** The composer's keys, ahead of the textarea. True when one was taken. */
  key(e, cx, chat, files) {
    const k = e.keystroke;
    if (this.menu) {
      const rows = this.rows(chat, files);
      if ((k === "down" || k === "up") && rows.length) {
        this.sel = (this.sel + (k === "down" ? 1 : rows.length - 1)) % rows.length;
        return true;
      }
      if ((k === "enter" || k === "tab") && rows.length) {
        this.pick(rows[Math.min(this.sel, rows.length - 1)]);
        return true;
      }
      if (k === "escape") {
        this.closedFor = this.value();
        this.menu = null;
        return true;
      }
    }
    if (k === "enter") {
      this.view.submit(cx, "send");
      return true;
    }
    if (k === "alt-enter") {
      this.view.submit(cx, "queue");
      return true;
    }
    return false;
  }

  /** The composer for `chat`. `running`: a turn runs; `offline`: the bridge is down (sending is off). */
  render(chat, { running = false, offline = false, files = [], preview = false } = {}) {
    const k = tokens();
    const queue = Array.isArray(chat?.queue) ? chat.queue : [];
    const paused = Boolean(chat?.queuePaused);
    const empty = !this.value().trim() && !this.attachments.length;
    const rows = [];
    if (queue.length) {
      rows.push(
        h_flex()
          .id("ac-queue")
          .pl(8)
          .pr(6)
          .pt(6)
          .gap(4)
          .items_center()
          .min_w(0)
          .child(
            h_flex()
              .id("ac-queue-label")
              .flex_none()
              .gap(4)
              .mr(2)
              .items_center()
              .tooltip(t(paused ? "assistant.queue.pausedHint" : "assistant.queue.hint"))
              .text_color(paused ? k.text.secondary : k.text.tertiary)
              .child(Icon(paused ? "circle-pause" : "list-ordered", { size: 12 }))
              .child(Text(paused ? t("assistant.queue.paused") : t("assistant.queue.label", { count: queue.length }), { size: "xs", tone: paused ? "secondary" : "tertiary", weight: paused ? "medium" : undefined, nowrap: true })),
          )
          .children(
            queue.map((q) =>
              h_flex()
                .id(`ac-chip-${q.id}`)
                .h(22)
                .max_w(180)
                .min_w(0)
                .flex_shrink_1()
                .pl(7)
                .pr(2)
                .gap(2)
                .items_center()
                .rounded(k.radius.sm)
                .border_1()
                .border_color(k.line.soft)
                .bg(k.bg.raised)
                .tooltip(q.text)
                .child(Text(q.text, { size: "sm", tone: paused ? "secondary" : "primary", truncate: true }).flex_shrink_1())
                .child(stopPress(IconButton(`ac-chip-x-${q.id}`, "x", t("assistant.queue.remove"), { iconSize: 12, disabled: preview, onClick: (_e, cx) => this.view.unqueue(cx, q.id) }).size(18).rounded(k.radius.sm))),
            ),
          )
          .when(paused, (e) => e.child(Spacer()).child(stopPress(Button("ac-resume", t("assistant.queue.resume"), { variant: "ghost", size: "sm", icon: "play", disabled: preview, onClick: (_e, cx) => this.view.resumeQueue(cx) })))),
      );
    }
    if (this.attachments.length) {
      rows.push(
        h_flex()
          .id("ac-atts")
          .px(8)
          .pt(6)
          .gap(4)
          .flex_wrap()
          .children(
            this.attachments.map((a) =>
              h_flex()
                .id(`ac-att-${a}`)
                .h(22)
                .pl(6)
                .pr(2)
                .gap(4)
                .items_center()
                .rounded(k.radius.sm)
                .border_1()
                .border_color(k.line.soft)
                .bg(k.bg.raised)
                .child(Icon("paperclip", { size: 12, color: k.text.tertiary }))
                .child(Text(a, { size: "xs", mono: true, nowrap: true }))
                .child(
                  stopPress(
                    IconButton(`ac-att-x-${a}`, "x", t("assistant.composer.removeAttachment", { name: a }), {
                      iconSize: 12,
                      onClick: (_e, cx) => {
                        this.attachments = this.attachments.filter((x) => x !== a);
                        cx.notify();
                      },
                    })
                      .size(18)
                      .rounded(k.radius.sm),
                  ),
                ),
            ),
          ),
      );
    }
    const placeholder = offline ? t("assistant.composer.offline") : running ? t("assistant.composer.placeholderRunning") : t("assistant.composer.placeholder");
    rows.push(
      div()
        .relative()
        .w_full()
        .min_h(32)
        .px(12)
        .pt(9)
        .pb(4)
        .when(this.value() === "", (e) => e.child(Text(placeholder, { tone: "tertiary", truncate: true }).absolute().top(9).left(12).right(12)))
        .child(Textarea.new(this.box).w_full().font_family(k.fonts.ui).text_size(k.fontSize.md).text_color(k.text.primary).accessibility_label(t("assistant.composer.label"))),
    );
    const send = BaseButton.new(running ? "ac-steer" : "ac-send")
      .h_flex()
      .tab_index(0)
      .flex_none()
      .size(k.control.md)
      .items_center()
      .justify_center()
      .rounded(k.radius.md)
      .bg(k.button.bg)
      .text_color(k.button.text)
      .accessibility_label(t(running ? "assistant.composer.steer" : "assistant.composer.send"))
      .tooltip(t(running ? "assistant.composer.steer" : "assistant.composer.send"))
      .disabled(empty || offline || preview)
      .child(Icon("arrow-up", { size: 14 }))
      .on_mouse_down("left", stop)
      .map((e) => (empty || offline || preview ? e.opacity(0.5) : e.cursor_pointer().hover((s) => s.opacity(0.9)).on_click((_e, cx) => this.view.submit(cx, "send"))));
    rows.push(
      h_flex()
        .id("ac-toolbar")
        .h(36)
        .px(6)
        .pb(4)
        .gap(2)
        .items_center()
        .child(stopPress(IconButton("ac-at", "at-sign", `${t("assistant.composer.attach")}  @`, { size: "md", disabled: offline || preview, onClick: (_e, cx) => (this.insert("@"), cx.notify()) }).size(k.control.sm)))
        .child(stopPress(IconButton("ac-slash", "square-slash", `${t("assistant.composer.commands")}  /`, { size: "md", disabled: offline || preview, onClick: (_e, cx) => (this.insert("/"), cx.notify()) }).size(k.control.sm)))
        .child(Text(t(running ? "assistant.composer.hintRunning" : "assistant.composer.hintIdle"), { size: "xs", tone: "tertiary", truncate: true }).ml(6).flex_shrink_1())
        .child(Spacer())
        .when(running, (e) => e.child(stopPress(Button("ac-stop", t("assistant.composer.stop"), { size: "sm", icon: "circle-stop", disabled: preview, onClick: (_e, cx) => this.view.stop(cx) })).mr(4)))
        .child(send),
    );
    const frame = v_flex()
      .id("ac-composer")
      .w_full()
      .rounded(k.radius.lg)
      .border_1()
      .border_color(this.focus.focused ? k.accent : k.line.strong)
      .bg(k.bg.card)
      .when(offline, (e) => e.opacity(0.6))
      .role("group")
      .accessibility_label(t("assistant.composer.label"))
      .on_key_down((e, cx) => {
        if (preview || !this.key(e, cx, chat, files)) return;
        cx.stop_propagation();
        cx.notify();
      })
      .on_mouse_down("left", (_e, cx) => {
        this.box.focus();
        cx.stop_propagation();
      })
      .children(rows);
    const list = this.menu && !preview ? this.listElement(chat, files) : null;
    return div()
      .flex_none()
      .px(12)
      .pb(12)
      .child(Popup.new("ac-composer-menu", frame).w_full().anchor("bottom_left").when(Boolean(list), (e) => e.content(list)));
  }

  /** The open @ or / list, above the box: the highlighted row, its key hint at the foot. */
  listElement(chat, files) {
    const k = tokens();
    const rows = this.rows(chat, files);
    const mention = this.menu.kind === "mention";
    const sel = Math.min(this.sel, Math.max(0, rows.length - 1));
    const item = (row, i) =>
      BaseButton.new(`ac-menu-${i}`)
        .h_flex()
        .w_full()
        .h(k.row.md)
        .px(8)
        .gap(8)
        .items_center()
        .rounded(k.radius.md)
        .cursor_pointer()
        .role("list_box_option")
        .selected(i === sel)
        .when(i === sel, (e) => e.bg(k.bg.selected))
        .hover((s) => s.bg(i === sel ? k.bg.selected : k.bg.hover))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => {
          this.pick(row);
          cx.notify();
        })
        .map((e) =>
          row.kind === "file"
            ? e
                .accessibility_label(row.path)
                .child(Icon("file-text", { size: 14, color: k.text.secondary }))
                .child(Text(row.path.slice(row.path.lastIndexOf("/") + 1), { truncate: true }).flex_1())
                .child(Text(row.path.includes("/") ? row.path.slice(0, row.path.lastIndexOf("/") + 1) : "", { size: "xs", tone: "tertiary", mono: true, nowrap: true }))
            : e
                .accessibility_label(`/${row.name}`)
                .child(Text(`/${row.name}`, { size: "sm", mono: true, nowrap: true }).w(84).flex_none())
                .child(Text(row.description, { size: "sm", tone: "secondary", truncate: true }).flex_1()),
        );
    return Menu({
      id: "ac-menu",
      width: mention ? 340 : 420,
      label: t(mention ? "assistant.mention.label" : "assistant.commands.label"),
      children: [
        MenuLabel(t(mention ? "assistant.mention.label" : "assistant.commands.label")),
        ...(rows.length ? rows.map(item) : [Text(t(mention ? "assistant.mention.empty" : "assistant.commands.empty"), { size: "sm", tone: "tertiary" }).px(8).py(4)]),
        h_flex().h(24).mt(2).px(8).items_center().border_t_1().border_color(k.line.soft).child(Text(t(mention ? "assistant.mention.hint" : "assistant.commands.hint"), { size: "xs", tone: "tertiary", nowrap: true })),
      ],
    }).mb(6);
  }
}
