// The Recap dialog (⌘R, DESIGN A3 Recap): every agent as a card grouped by whose move it is, with its AI recap
// (cached per session, written on request), the question it waits on answered in place (`hc read` shown, `hc keys` /
// `hc send` to answer), snooze, fork into a new tab, its prompt queue; a Time tab with the week's agent time per ticket.
// Opened by the `recap` command (this module registers it) or Home's Recap button: openRecap(tab).
//
// Keys: ↑/↓ (j/k) move, ⏎ go to it, ⇥ reply, 1–9 choose, R recap, S snooze, F fork, Q queue, ←/→ stage, / filter,
// esc close.

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState } from "gpui-base";
import { props, closeOverlay, openOverlay, exec, shared } from "herdr";
import { t } from "../core/i18n.js";
import * as fleet from "../sys/fleet.js";
import * as queue from "../sys/queue.js";
import { handle } from "../sys/bus.js";
import { MOD } from "../sys/state.js";
import { tokens } from "../ui/tokens.js";
import { ViewRoot, Text, TextInput, IconButton, TabBar, Empty, SectionHeader, trackFocus } from "../ui/kit.js";
import { Notice, pressFocus, inField } from "./apps/ui.js";
import { STAGE_ORDER, STAGE_META, stageColor, toolName, project, taskOf, inStage, ensureTail, tailOf, loadRecap, makeRecap, choose, reply, snooze, fork, goTo } from "./apps/agents.js";
import { probeHost, hostLocal } from "./apps/snapshot.js";
import { recapCard, timeTable, hints } from "./apps/recap-parts.js";

const TABS = ["all", ...STAGE_ORDER, "time"];

/** Opens the Recap dialog, on a stage's tab when given. Returns the overlay id. */
export function openRecap(tab) {
  return openOverlay({ mod: MOD, props: { view: "recap", ...(TABS.includes(tab) ? { tab } : {}) }, kind: "dialog", width: 940, height: 0.86 });
}

handle("recap", () => {
  openRecap();
});

export default class Recap {
  constructor(name) {
    this.name = name;
  }

  /** Acts only as a real copy on a host known to run commands: never as a preview, never while the host check has not
   *  answered, never on a herdr-relay device (the same gate as Home and the Inbox). */
  get live() {
    return !this.preview && hostLocal();
  }

  init(_p, cx) {
    const p = props() ?? {};
    this.preview = p.preview === true;
    if (!this.preview) probeHost(cx);
    this.tab = TABS.includes(p.tab) ? p.tab : "all";
    this.sel = null;
    this.replying = null;
    this.snoozing = null;
    this.notice = new Notice();
    this.handle = cx.focus_handle();
    this.filter = InputState.new({ placeholder: t("home.recap.filter") });
    this.filterFocus = trackFocus(this.filter);
    this.filter.on("change", (_e, cx) => cx.notify());
    this.filter.on("submit", (_e, cx) => (this.handle.focus(), cx.notify()));
    this.replyInput = InputState.new({ placeholder: t("home.next.replyPlaceholder") });
    this.replyFocus = trackFocus(this.replyInput);
    this.replyInput.on("submit", (_e, cx) => this.sendReply(cx));
    // The dialog's element exists only after its first draw: the keyboard moves there then.
    cx.timer.after(50, () => this.handle.focus());
    cx.timer.every(2000, (cx) => this.watch(cx));
    this.watch(cx);
  }

  /** The cards the tab and the filter leave, in board order. */
  shown(rows = fleet.rows()) {
    const q = this.filter.value().trim().toLowerCase();
    const match = (r) => !q || [taskOf(r), toolName(r), project(r), r.branch, r.ticket?.key, r.space_name, r.tab_name, r.pr?.title].some((x) => String(x ?? "").toLowerCase().includes(q));
    const stages = this.tab === "all" ? STAGE_ORDER : STAGE_ORDER.includes(this.tab) ? [this.tab] : [];
    return stages.flatMap((s) => inStage(rows, s)).filter(match);
  }

  selected(rows) {
    const list = this.shown(rows);
    return list.find((r) => r.address === this.sel) ?? list[0] ?? null;
  }

  /** Kept recaps are read for every card shown; the selected agent's screen is read when it changed. */
  watch(cx) {
    if (!this.preview) probeHost(cx);
    if (!this.live) return;
    const rows = fleet.rows();
    const list = this.shown(rows);
    for (const r of list) loadRecap(cx, r);
    const s = this.selected(rows);
    if (s) ensureTail(cx, s);
  }

  dismiss() {
    if (props()?.overlay) closeOverlay(props().overlay);
  }

  // Actions.

  pick(cx, row) {
    if (this.sel !== row.address) {
      this.sel = row.address;
      this.replying = null;
      this.snoozing = null;
      if (this.live) ensureTail(cx, row);
    }
    // A press inside the open reply field keeps the keyboard there.
    if (!this.replying) this.handle.focus();
    cx.notify();
  }

  go(_cx, row) {
    goTo(row.address);
    this.dismiss();
  }

  recap(cx, row) {
    if (!this.live) return;
    makeRecap(cx, row);
    cx.notify();
  }

  startReply(cx, row) {
    if (!this.live || row.status !== "blocked") return;
    this.composer = (this.composer ?? 0) + 1;
    this.sel = row.address;
    this.replying = row.address;
    this.replyInput.set_value("");
    this.replyInput.focus();
    cx.notify();
  }

  cancelReply(cx) {
    this.composer = (this.composer ?? 0) + 1;
    this.replying = null;
    this.handle.focus();
    cx.notify();
  }

  /** The agent at `address` when it still waits for an answer, else null with a notice (the typed text stays). */
  stillWaiting(cx, address) {
    const a = fleet.rows().find((r) => r.address === address);
    if (a?.status === "blocked") return a;
    this.notice.show(cx, { tone: "warning", text: a ? t("home.next.notWaiting", { tool: toolName(a), project: project(a) }) : t("home.next.gone") });
    return null;
  }

  /** Sends the typed answer to the agent the composer was opened for, never another; kept when it is not sent. */
  sendReply(cx) {
    const address = this.replying;
    const text = this.replyInput.value().trim();
    if (!address || !text || this.sending || !this.stillWaiting(cx, address)) return;
    this.sending = true;
    const composer = this.composer;
    cx.spawn(async (cx) => {
      const r = await reply(address, text);
      this.sending = false;
      // Sent: the composer it came from closes, and its text goes only while unchanged; a newer composer keeps its own.
      if (!r.error && this.composer === composer && this.replying === address) {
        this.replying = null;
        if (this.replyInput.value().trim() === text) this.replyInput.set_value("");
        this.handle.focus();
      }
      this.answered(cx, address, r);
    });
    cx.notify();
  }

  /** Presses choice `n` of the question drawn at `seq` (the state it was read at, captured with the choices): refused
   *  when the screen or the agent moved on since (agents.js `choose`). */
  choose(cx, row, n, seq) {
    if (!this.live || !this.stillWaiting(cx, row.address)) return;
    cx.spawn(async (cx) => this.answered(cx, row.address, await choose(row.address, n, seq)));
  }

  answered(cx, address, r) {
    if (r.error) this.notice.show(cx, { tone: "error", text: t("home.next.notSent"), body: r.error });
    else this.notice.show(cx, { tone: "success", text: t("home.next.sent") });
    const row = fleet.rows().find((x) => x.address === address);
    if (row) ensureTail(cx, row, { force: true });
  }

  toggleSnooze(cx, row) {
    this.snoozing = this.snoozing === row.address ? null : row.address;
    cx.notify();
  }

  snooze(cx, row, kind) {
    if (!this.live) return;
    snooze(row.address, kind);
    this.snoozing = null;
    this.notice.show(cx, { tone: "info", text: t("home.recap.snoozed", { task: taskOf(row), until: t(`home.snooze.${kind}`) }), action: { label: t("home.next.undo"), onClick: (_e, cx) => (snooze(row.address, null), cx.notify()) } });
  }

  wake(cx, row) {
    if (!this.live) return;
    snooze(row.address, null);
    cx.notify();
  }

  fork(cx, row) {
    if (!this.live) return;
    if (fork(row)) this.dismiss();
    else this.notice.show(cx, { tone: "warning", text: t("home.recap.forkNone") });
  }

  queue(_cx, row) {
    if (!this.live) return;
    this.dismiss();
    queue.open(row.address);
  }

  openUrl(cx, url) {
    if (url && this.live) exec("open", [url]).catch(() => {});
    cx.notify();
  }

  setTab(cx, tab) {
    this.tab = tab;
    this.replying = null;
    this.snoozing = null;
    cx.notify();
  }

  step(cx, by) {
    const list = this.shown();
    if (!list.length) return;
    const at = Math.max(0, list.findIndex((r) => r.address === this.selected()?.address));
    this.pick(cx, list[Math.max(0, Math.min(list.length - 1, at + by))]);
  }

  // Keys.

  key(e, cx) {
    const k = e.keystroke;
    if (this.replying) {
      if (k === "escape") this.cancelReply(cx);
      return k === "escape";
    }
    if (this.filterFocus.focused) {
      if (k === "escape" || k === "down") {
        this.handle.focus();
        cx.notify();
        return true;
      }
      return false;
    }
    const row = this.selected();
    if (this.snoozing && row && /^[1-3]$/.test(k)) {
      this.snooze(cx, row, ["hour", "evening", "tomorrow"][Number(k) - 1]);
      return true;
    }
    const tabAt = TABS.indexOf(this.tab);
    switch (k) {
      case "escape":
        if (this.snoozing) this.snoozing = null;
        else this.dismiss();
        return true;
      case "down":
      case "j":
        this.step(cx, 1);
        return true;
      case "up":
      case "k":
        this.step(cx, -1);
        return true;
      case "right":
        this.setTab(cx, TABS[(tabAt + 1) % TABS.length]);
        return true;
      case "left":
        this.setTab(cx, TABS[(tabAt - 1 + TABS.length) % TABS.length]);
        return true;
      case "/":
        this.filter.focus();
        return true;
    }
    if (!row || this.tab === "time") return false;
    const tail = tailOf(row.address);
    const q = tail?.question;
    if (k === "enter") this.go(cx, row);
    else if (k === "tab") this.startReply(cx, row);
    else if (k === "r") this.recap(cx, row);
    else if (k === "s") (row.snoozedUntil ? this.wake(cx, row) : this.toggleSnooze(cx, row));
    else if (k === "f") this.fork(cx, row);
    else if (k === "q") this.queue(cx, row);
    else if (/^[1-9]$/.test(k) && row.status === "blocked" && q?.choices?.some((c) => c.n === Number(k))) this.choose(cx, row, Number(k), tail.seq);
    else return false;
    return true;
  }

  list(rows, now) {
    if (this.tab === "time") return [timeTable(rows, now)];
    const shown = this.shown(rows);
    if (!shown.length) {
      return [Empty({ id: "rc-empty", icon: "bot", title: this.filter.value().trim() ? t("home.recap.noMatch") : t("home.recap.empty"), body: t("home.recap.emptyBody") })];
    }
    const sel = this.selected(rows);
    if (sel && sel.address !== this.sel) this.sel = sel.address;
    const out = [];
    let last = null;
    // Agent time per ticket: read once for every card of this render.
    const time = shown.some((r) => r.ticket) ? fleet.time(now) : null;
    for (const r of shown) {
      if (this.tab === "all" && r.stage !== last) {
        const k = tokens();
        out.push(
          div()
            .pt(last ? 8 : 0)
            .child(SectionHeader({ variant: "column", icon: STAGE_META[r.stage].icon, iconColor: r.stage === "done" ? k.text.secondary : stageColor(r.stage, k), title: t(`home.stage.${r.stage}`), count: shown.filter((x) => x.stage === r.stage).length })),
        );
        last = r.stage;
      }
      out.push(recapCard(this, r, now, time));
    }
    return out;
  }

  render(_cx) {
    const k = tokens();
    const now = Date.now();
    shared("lazuli.apps.recaps");
    const rows = fleet.rows(now);
    const counts = Object.fromEntries(STAGE_ORDER.map((s) => [s, rows.filter((r) => r.stage === s).length]));
    const items = TABS.map((key) => ({ key, label: key === "all" ? t("home.recap.all") : key === "time" ? t("home.recap.time") : t(`home.stage.${key}`), count: key === "all" ? rows.length : key === "time" ? undefined : counts[key] }));
    const banner = this.notice.render("rc-notice", t("common.close"));
    return ViewRoot("lz-recap", { bg: k.bg.popover })
      .relative()
      .track_focus(this.handle)
      .on_mouse_down("left", pressFocus(this, () => Boolean(this.replying)))
      .on_key_down((e, cx) => {
        if (this.key(e, cx)) {
          cx.stop_propagation();
          cx.notify();
        }
      })
      .child(
        h_flex()
          .flex_none()
          .px(20)
          .pt(16)
          .pb(10)
          .gap(12)
          .items_center()
          .child(Text(t("home.recap.title"), { size: "lg", weight: "semibold", nowrap: true }))
          .child(div().flex_1().max_w(420).child(inField(this, TextInput(this.filter, { id: "rc-filter", focused: this.filterFocus.focused, icon: "search", a11y: t("home.recap.filter") }))))
          .child(div().flex_1())
          .child(IconButton("rc-close", "x", t("common.close"), { onClick: () => this.dismiss() })),
      )
      .child(TabBar("rc-tabs", items, this.tab, (key, cx) => this.setTab(cx, key), { label: t("home.recap.title") }))
      .child(v_flex().id("rc-list").flex_1().min_h(0).px(20).py(14).gap(10).overflow_y_scrollbar().children(this.list(rows, now)))
      .when(Boolean(banner), (e) => e.child(div().flex_none().px(20).pb(8).child(banner)))
      .child(hints());
  }
}
