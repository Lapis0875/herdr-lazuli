// The per-agent prompt queue (DESIGN A3 Queue, ARCHITECTURE §4.7): follow-ups written while an agent works, sent one at
// a time or all at once as one numbered prompt (sys/queue.js). Two places:
// - the floating drawer on the window's right edge (layout `floating: queue`): its count peeks out, and the queue of
//   the agent in front slides out on hover. It shows on Home and the work view, and only when prompts wait.
// - the dialog (⌥⌘Q, queue.open(address)): `props().address` is the agent (null when none was focused: pick one).
// Every edit goes through sys/queue.js; its notes and errors are named through `home.queue.*`.

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState } from "gpui-base";
import { props, placement, closeOverlay, agents, home } from "herdr";
import { t } from "../core/i18n.js";
import * as queue from "../sys/queue.js";
import * as fleet from "../sys/fleet.js";
import { activeChild } from "../sys/bus.js";
import { NODE } from "../sys/state.js";
import { tokens } from "../ui/tokens.js";
import { ViewRoot, Text, Icon, Button, IconButton, Count, Chip, TextInput, Empty, Kbd, Banner, trackFocus } from "../ui/kit.js";
import { Mark, toolName, project, taskOf } from "./apps/agents.js";
import { span, tilde, firstLine } from "./apps/fmt.js";
import { pressFocus, inField } from "./apps/ui.js";

const EDGE = 44;
const WIDTH = 340;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const list_ = (v) => (Array.isArray(v) ? v : []);

export default class Queue {
  constructor(name) {
    this.name = name;
  }

  init(_p, cx) {
    const p = props() ?? {};
    this.live = p.preview !== true;
    this.dialog = own(p, "address") || Boolean(p.overlay);
    this.target = typeof p.address === "string" && p.address ? p.address : null;
    this.editing = null;
    this.message = null;
    this.busy = false;
    // A damaged queue file's reset, and dropping an interrupted delivery (its id), wait for a second press.
    this.confirmReset = false;
    this.confirmDrop = null;
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: t("home.queue.placeholder") });
    this.inputFocus = trackFocus(this.input);
    this.input.on("submit", (_e, cx) => this.add(cx));
    this.edit = InputState.new({ placeholder: t("home.queue.editPlaceholder") });
    this.editFocus = trackFocus(this.edit);
    this.edit.on("submit", (_e, cx) => this.saveEdit(cx));
    if (this.dialog) cx.timer.after(50, () => (this.target ? this.input.focus() : this.handle.focus()));
  }

  /** The agents a queue can be for: every agent, the focused first. */
  agentsNow() {
    return fleet.rows().sort((a, b) => Number(b.focused) - Number(a.focused));
  }

  /** The agent whose queue shows: the dialog's, else the one in front, else the first with prompts waiting. */
  current(list) {
    const queues = queue.get().queues;
    const front = queue.focusedAgent();
    const want = this.target ?? (this.dialog ? null : front);
    return list.find((a) => a.address === want) ?? (this.dialog ? null : list.find((a) => (queues[a.address] ?? []).length) ?? null);
  }

  /** Runs a queue action and shows its note or error. `errors`: error codes with a text of their own for this action. */
  async run(cx, job, errors = {}) {
    if (!this.live) return;
    this.busy = true;
    cx.notify();
    const r = await job();
    this.busy = false;
    if (r.error) this.message = { tone: "error", text: t(errors[r.error] ?? `home.queue.error.${r.error}`) };
    else if (r.note === "sent") this.message = { tone: "success", text: t("home.queue.note.sent", { n: r.texts.length }) };
    else if (r.note === "reset") this.message = { tone: "success", text: t("home.queue.note.reset", { backup: tilde(r.backup, home()) }) };
    // A file lazuli cannot rewrite (not UTF-8, over 1 MiB): copied aside, left in place for the person to fix.
    else if (r.note === "backed-up") this.message = { tone: "warning", text: t("home.queue.note.backed-up", { backup: tilde(r.backup, home()) }) };
    else if (r.note && r.note !== "queued") this.message = { tone: "info", text: t(`home.queue.note.${r.note}`) };
    else this.message = null;
    cx.notify();
    return r;
  }

  add(cx) {
    const a = this.current(this.agentsNow());
    const text = this.input.value().trim();
    if (!a || !text) return;
    // The field empties once the prompt is queued; a refused one (a damaged file, say) stays to try again.
    cx.spawn(async (cx) => {
      const r = await this.run(cx, () => queue.add(a.address, text));
      if (r && !r.error && this.input.value().trim() === text) this.input.set_value("");
    });
  }

  /** Asks before setting a damaged queue file aside (`confirmReset`), then does it. */
  askReset(cx) {
    if (!this.live) return;
    this.confirmReset = true;
    cx.notify();
  }

  reset(cx) {
    this.confirmReset = false;
    // `stale` here: a newer queue file took the damaged one's place and was kept.
    cx.spawn(async (cx) => this.run(cx, () => queue.resetCorrupt(), { stale: "home.queue.error.resetStale" }));
  }

  /** An interrupted delivery's prompts back in their queue (none is sent). */
  restoreDelivery(cx, id) {
    this.confirmDrop = null;
    cx.spawn(async (cx) => this.run(cx, () => queue.restoreInterrupted(id)));
  }

  /** Dropping an interrupted delivery's prompts waits for a second press. */
  askDrop(cx, id) {
    if (!this.live) return;
    this.confirmDrop = id;
    cx.notify();
  }

  drop(cx, id) {
    this.confirmDrop = null;
    cx.spawn(async (cx) => this.run(cx, () => queue.dropInterrupted(id)));
  }

  startEdit(cx, address, item) {
    if (!this.live) return;
    this.editing = { address, id: item.id };
    this.edit.set_value(item.text);
    this.edit.focus();
    cx.notify();
  }

  saveEdit(cx) {
    const e = this.editing;
    if (!e) return;
    const text = this.edit.value().trim();
    this.editing = null;
    this.handle.focus();
    cx.spawn(async (cx) => this.run(cx, () => (text ? queue.edit(e.address, e.id, text) : queue.remove(e.address, e.id))));
  }

  cancelEdit(cx) {
    this.editing = null;
    this.handle.focus();
    cx.notify();
  }

  key(e, cx) {
    const k = e.keystroke;
    if (this.editing) {
      if (k === "escape") this.cancelEdit(cx);
      return k === "escape";
    }
    if (k === "escape" && (this.confirmReset || this.confirmDrop)) {
      this.confirmReset = false;
      this.confirmDrop = null;
      return true;
    }
    if (k === "escape" && this.dialog) {
      if (props()?.overlay) closeOverlay(props().overlay);
      return true;
    }
    if (this.inputFocus.focused) return false;
    const a = this.current(this.agentsNow());
    const items = a ? queue.itemsFor(a.address) : [];
    if (k === "cmd-enter") {
      // Like the button: nothing while an action runs. Busy is set at once, so a second press before the send starts
      // finds it too.
      if (!a || !items.length || !this.live) return false;
      if (this.busy) return true;
      this.busy = true;
      cx.spawn(async (cx) => this.run(cx, () => queue.sendAll(a.address)));
    } else if (k === "a" && a) this.input.focus();
    else return false;
    return true;
  }

  // Drawing.

  statusLine(a) {
    if (!a) return "";
    const word = a.status === "working" ? "home.queue.working" : a.status === "blocked" ? "home.queue.blocked" : "home.queue.ready";
    return t(word);
  }

  itemRow(a, item, i, count, now) {
    const k = tokens();
    const editing = this.editing?.id === item.id;
    const busy = this.busy || !this.live;
    return h_flex()
      .id(`q-${item.id}`)
      .w_full()
      .min_h(34)
      .px(8)
      .py(6)
      .gap(8)
      .items_start()
      .rounded(k.radius.md)
      .hover((s) => s.bg(k.bg.hover))
      .child(Text(String(i + 1), { size: "sm", mono: true, tone: "accent" }).w(14).flex_none().pt(1))
      .child(
        editing
          ? inField(this, TextInput(this.edit, { id: `q-${item.id}-edit`, focused: this.editFocus.focused, a11y: t("home.queue.editLabel") }))
          : div()
              .id(`q-${item.id}-text`)
              .flex_1()
              .min_w(0)
              .cursor_text()
              .tooltip(t("home.queue.itemTip", { time: span(now - (item.at ?? now)) }))
              .on_click((e, cx) => {
                if (e.click_count > 1) this.startEdit(cx, a.address, item);
              })
              .child(Text(item.text, { size: "sm" }).whitespace_normal()),
      )
      .child(
        h_flex()
          .flex_none()
          .gap(2)
          .when(!editing, (e) => e.child(IconButton(`q-${item.id}-edit-btn`, "pencil", t("home.queue.edit"), { disabled: busy, onClick: (_e, cx) => this.startEdit(cx, a.address, item) })))
          .child(IconButton(`q-${item.id}-up`, "arrow-up", t("home.queue.up"), { disabled: busy || i === 0, onClick: (_e, cx) => cx.spawn(async (cx) => this.run(cx, () => queue.move(a.address, item.id, i - 1))) }))
          .child(IconButton(`q-${item.id}-down`, "arrow-down", t("home.queue.down"), { disabled: busy || i === count - 1, onClick: (_e, cx) => cx.spawn(async (cx) => this.run(cx, () => queue.move(a.address, item.id, i + 1))) }))
          .child(IconButton(`q-${item.id}-send`, "send", t("home.queue.sendOne"), { disabled: busy, onClick: (_e, cx) => cx.spawn(async (cx) => this.run(cx, () => queue.send(a.address, item.id))) }))
          .child(IconButton(`q-${item.id}-rm`, "x", t("home.queue.remove"), { disabled: busy, onClick: (_e, cx) => cx.spawn(async (cx) => this.run(cx, () => queue.remove(a.address, item.id))) })),
      );
  }

  body(list, a) {
    const k = tokens();
    const now = Date.now();
    const queues = queue.get().queues;
    const items = a ? queue.itemsFor(a.address) : [];
    const corrupt = queue.get().corrupt === true;
    const busy = this.busy || !this.live;
    // Every agent, wrapped; past a few rows the picker scrolls (a plain scroll area: its height is its own max).
    const picker = div()
      .id("q-pick")
      .flex_none()
      .max_h(96)
      .overflow_y_scroll()
      .child(
        h_flex()
          .flex_wrap()
          .gap(4)
          .children(
            list.map((x) => {
              const n = (queues[x.address] ?? []).length;
              const on = x.address === a?.address;
              return Chip(n ? t("home.queue.pickCount", { name: taskOf(x), n }) : taskOf(x), {
                id: `q-pick-${x.address}`,
                icon: on ? "check" : undefined,
                tone: on ? "pr" : "default",
                tooltip: `${toolName(x)} · ${project(x)}`,
                onClick: (_e, cx) => {
                  this.target = x.address;
                  this.editing = null;
                  cx.notify();
                },
              });
            }),
          ),
      );
    return v_flex()
      .when(!this.dialog, (e) => e.w(WIDTH).flex_none().max_h(460))
      .when(this.dialog, (e) => e.flex_1().min_h(0))
      .p(12)
      .gap(10)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(Icon("list-ordered", { size: 15, color: k.accent }))
          .child(Text(t("home.queue.title"), { weight: "semibold", nowrap: true }))
          .child(Count(items.length))
          .child(div().flex_1())
          .when(this.dialog, (e) => e.child(Kbd("esc"))),
      )
      .when(corrupt, (e) => e.child(this.corruptBlock(busy)))
      .when(!corrupt && list_(queue.get().interrupted).length > 0, (e) => e.child(this.interruptedBlock(busy)))
      .when(list.length > 1 || (this.dialog && !a), (e) => e.child(picker))
      .when(Boolean(a), (e) =>
        e.child(
          h_flex()
            .gap(6)
            .items_center()
            .min_w(0)
            .child(Mark(a, { size: 13 }))
            .child(Text(`${taskOf(a)} · ${this.statusLine(a)}`, { size: "xs", tone: "secondary", truncate: true }).flex_1()),
        ),
      )
      .child(
        v_flex()
          .id("q-list")
          .gap(2)
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .when(!items.length && !corrupt, (e) => e.child(Empty({ id: "q-empty", icon: "list-ordered", title: a ? t("home.queue.empty") : list.length ? t("home.queue.pick") : t("home.queue.noAgent"), body: a ? t("home.queue.emptyBody") : undefined })))
          .children(items.map((item, i) => this.itemRow(a, item, i, items.length, now))),
      )
      .when(Boolean(a), (e) =>
        e.child(
          h_flex()
            .gap(6)
            .items_center()
            .child(inField(this, TextInput(this.input, { id: "q-input", focused: this.inputFocus.focused, icon: "plus", a11y: t("home.queue.addLabel") })))
            .child(Button("q-add", t("home.queue.add"), { size: "sm", kbd: "⏎", disabled: busy || corrupt, onClick: (_e, cx) => this.add(cx) })),
        ),
      )
      .when(Boolean(this.message), (e) => e.child(Text(this.message.text, { size: "xs", tone: this.message.tone }).role(this.message.tone === "error" ? "alert" : "status")))
      .when(items.length > 0, (e) =>
        e.child(
          h_flex()
            .gap(6)
            .child(Button("q-clear", t("home.queue.clear"), { variant: "ghost", size: "sm", disabled: busy, onClick: (_e, cx) => cx.spawn(async (cx) => this.run(cx, () => queue.clear(a.address))) }))
            .child(div().flex_1())
            .child(Button("q-send-next", t("home.queue.sendNext"), { size: "sm", disabled: busy, onClick: (_e, cx) => cx.spawn(async (cx) => this.run(cx, () => queue.send(a.address, items[0].id))) }))
            .child(
              Button("q-send-all", items.length > 1 ? t("home.queue.sendAll", { n: items.length }) : t("home.queue.send"), {
                variant: "primary",
                size: "sm",
                icon: "send",
                kbd: this.dialog ? "⌘⏎" : undefined,
                tooltip: t("home.queue.sendAllTip"),
                disabled: busy,
                onClick: (_e, cx) => cx.spawn(async (cx) => this.run(cx, () => queue.sendAll(a.address))),
              }),
            ),
        ),
      );
  }

  /** The queue file is damaged: lazuli leaves it untouched; Reset (asked twice) sets it aside and starts empty. */
  corruptBlock(busy) {
    const confirming = this.confirmReset === true;
    return v_flex()
      .id("q-corrupt")
      .gap(6)
      .child(
        Banner({
          id: "q-corrupt-banner",
          tone: "warning",
          title: confirming ? t("home.queue.corrupt.confirmTitle") : t("home.queue.corrupt.title"),
          body: confirming ? t("home.queue.corrupt.confirmBody") : t("home.queue.corrupt.body"),
        }),
      )
      .child(
        h_flex()
          .gap(6)
          .justify_end()
          .when(confirming, (e) =>
            e
              .child(Button("q-reset-cancel", t("common.cancel"), { variant: "ghost", size: "sm", kbd: "esc", onClick: (_e, cx) => ((this.confirmReset = false), cx.notify()) }))
              .child(Button("q-reset-ok", t("home.queue.corrupt.resetNow"), { variant: "primary", size: "sm", icon: "rotate-ccw", disabled: busy, onClick: (_e, cx) => this.reset(cx) })),
          )
          .when(!confirming, (e) => e.child(Button("q-reset", t("home.queue.corrupt.reset"), { size: "sm", icon: "rotate-ccw", disabled: busy, onClick: (_e, cx) => this.askReset(cx) }))),
      );
  }

  /** Deliveries whose outcome is unknown (Herdr quit around `hc send`: they may or may not have arrived). Nothing
   *  resends them; after checking the terminal the person puts each back in its queue or, pressing twice, drops it. */
  interruptedBlock(busy) {
    const rows = fleet.rows();
    return v_flex()
      .id("q-interrupted")
      .gap(8)
      .children(
        list_(queue.get().interrupted).map((d) => {
          const agent = rows.find((r) => r.address === d.address);
          const items = list_(d.items);
          const dropping = this.confirmDrop === d.id;
          const shown = items.slice(0, 3).map((i, n) => `${n + 1}. ${firstLine(i.text, 90)}`);
          if (items.length > 3) shown.push(t("home.queue.interrupted.more", { n: items.length - 3 }));
          return v_flex()
            .id(`q-int-${d.id}`)
            .gap(6)
            .child(
              Banner({
                id: `q-int-${d.id}-banner`,
                tone: "warning",
                title: dropping ? t("home.queue.interrupted.dropTitle", { n: items.length }) : t("home.queue.interrupted.title", { n: items.length, name: agent ? taskOf(agent) : d.address }),
                body: dropping ? t("home.queue.interrupted.dropBody") : [...shown, t("home.queue.interrupted.body", { time: span(Date.now() - (d.at ?? Date.now())) })].join("\n"),
              }),
            )
            .child(
              h_flex()
                .gap(6)
                .justify_end()
                .when(dropping, (e) =>
                  e
                    .child(Button(`q-int-${d.id}-keep`, t("common.cancel"), { variant: "ghost", size: "sm", kbd: "esc", onClick: (_e, cx) => ((this.confirmDrop = null), cx.notify()) }))
                    .child(Button(`q-int-${d.id}-drop-ok`, t("home.queue.interrupted.dropNow"), { variant: "primary", size: "sm", icon: "trash-2", disabled: busy, onClick: (_e, cx) => this.drop(cx, d.id) })),
                )
                .when(!dropping, (e) =>
                  e
                    .child(Button(`q-int-${d.id}-drop`, t("home.queue.interrupted.drop"), { variant: "ghost", size: "sm", disabled: busy, onClick: (_e, cx) => this.askDrop(cx, d.id) }))
                    .child(Button(`q-int-${d.id}-restore`, t("home.queue.interrupted.restore"), { variant: "primary", size: "sm", icon: "rotate-ccw", disabled: busy, onClick: (_e, cx) => this.restoreDelivery(cx, d.id) })),
                ),
            );
        }),
      );
  }

  render(_cx) {
    const k = tokens();
    const list = this.agentsNow();
    const a = this.current(list);
    if (this.dialog) {
      return ViewRoot("lz-queue", { bg: k.bg.popover })
        .track_focus(this.handle)
        .on_mouse_down("left", pressFocus(this, () => Boolean(this.editing)))
        .on_key_down((e, cx) => {
          if (this.key(e, cx)) {
            cx.stop_propagation();
            cx.notify();
          }
        })
        .child(this.body(list, a));
    }
    // The drawer: hidden off Home and the work view, and while nothing waits (unless the pointer is on it).
    const p = placement();
    const total = queue.get().count ?? 0;
    const corrupt = queue.get().corrupt === true;
    const interrupted = list_(queue.get().interrupted).length;
    const center = activeChild(NODE.center);
    if ((!total && !corrupt && !interrupted && !p?.hovered) || !["home", "work"].includes(center ?? "home") || !agents().length) return div().size(0);
    const edge = v_flex()
      .id("q-edge")
      .w(EDGE)
      .flex_none()
      .py(10)
      .gap(6)
      .items_center()
      .accessibility_label(corrupt ? t("home.queue.corrupt.title") : interrupted ? t("home.queue.interrupted.edge", { n: interrupted }) : t("home.queue.drawer", { n: total }))
      .child(
        h_flex()
          .relative()
          .size(28)
          .items_center()
          .justify_center()
          .child(corrupt || interrupted ? Icon("triangle-alert", { size: 16, color: k.state.warning }) : Icon("list-ordered", { size: 16, color: total ? k.accent : k.text.tertiary }))
          .when(total > 0, (e) => e.child(Count(total, { tone: "accent", ring: k.bg.popover }).absolute().top(-4).right(-6))),
      );
    const left = p?.edge === "left";
    return h_flex()
      .id("lz-queue-drawer")
      .items_start()
      .rounded(k.radius.lg)
      .bg(k.bg.popover)
      .border_1()
      .border_color(k.line.soft)
      .shadow_md()
      .text_color(k.text.primary)
      .font_family(k.fonts.ui)
      .text_size(k.fontSize.md)
      .on_key_down((e, cx) => {
        if (this.key(e, cx)) {
          cx.stop_propagation();
          cx.notify();
        }
      })
      .when(left, (e) => e.child(edge).child(this.body(list, a)))
      .when(!left, (e) => e.child(this.body(list, a)).child(edge));
  }
}
