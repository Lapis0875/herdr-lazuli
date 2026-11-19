// Home (DESIGN A3, mockup docs/mockups/a-lapis/home.html): the next action, the stage board of agents with their PRs
// (fleet: Herdr's agents joined with gh), the apps in a few rows (Inbox, To-do, Routines), the week's spend, recent
// events and the terminals whose session restore is pending or failed. When it is shown it asks GitHub and the spend
// scan for fresh data (gh.opened, scan.refreshUsage). A preview copy (`props().preview`) only draws.
//
// Keys while Home has the keyboard: T reply in words, 1–9 pick a choice, L later (snooze an hour), ⏎ go to the agent;
// ⌘J, ⌘R and ⌥⌘R are the window's own.

import { h_flex, v_flex, InputState } from "gpui-base";
import { props, exec } from "herdr";
import { t } from "../core/i18n.js";
import * as gh from "../sys/gh.js";
import * as fleet from "../sys/fleet.js";
import * as scan from "../sys/scan.js";
import * as todo from "../sys/todo.js";
import * as resume from "../sys/resume.js";
import { activeChild, layoutNode, hideInCenter } from "../sys/bus.js";
import { NODE } from "../sys/state.js";
import { tokens } from "../ui/tokens.js";
import { ViewRoot, trackFocus } from "../ui/kit.js";
import { Notice, pressFocus } from "./apps/ui.js";
import { openApp } from "./apps/nav.js";
import { nextUp, ensureTail, tailOf, choose, reply, snooze, goTo, openBeside, project, toolName } from "./apps/agents.js";
import { probeHost, snapshotMode, hostLocal, refreshSaved, boardRows } from "./apps/snapshot.js";
import { header, snapshotNote, nextBar, board, keyHints } from "./apps/home-board.js";
import { strip, lower } from "./apps/home-strip.js";
import { openRecap } from "./recap.js";

const WATCH_MS = 1500;
const CLOCK_MS = 30000;

export default class Home {
  constructor(name) {
    this.name = name;
  }

  /** Acts only as the layout's own copy on a live Mac: never as a preview, never on a relay device's snapshot. */
  get live() {
    return !this.preview && hostLocal();
  }

  init(_p, cx) {
    this.preview = props()?.preview === true;
    // A relay device: the board draws the Mac's saved fleet and acts on nothing. Only herdr-relay's refusal says so.
    if (!this.preview) probeHost(cx);
    this.snapshot = snapshotMode();
    this.snapshotAt = null;
    this.now = Date.now();
    this.shown = false;
    // The address of the agent the open reply composer answers, or null; `sending` while its answer goes out;
    // `draftFor` the agent the text in the field was written for.
    this.replying = null;
    this.sending = false;
    this.draftFor = null;
    this.notice = new Notice();
    this.handle = cx.focus_handle();
    this.replyInput = InputState.new({ placeholder: t("home.next.replyPlaceholder") });
    this.replyFocus = trackFocus(this.replyInput);
    this.replyInput.on("submit", (_e, cx) => this.sendReply(cx));
    cx.timer.every(WATCH_MS, (cx) => this.watch(cx));
    cx.timer.every(CLOCK_MS, (cx) => {
      this.now = Date.now();
      if (this.isShown()) cx.notify();
    });
    // Saved data (read only) loads whatever the host turns out to be; acting waits for `live`.
    gh.load();
    this.watch(cx);
  }

  isShown() {
    return activeChild(NODE.center) === "home";
  }

  /** Becoming shown asks for fresh data; while shown, the next agent's screen is read when it changes. */
  watch(cx) {
    const shown = this.isShown();
    if (!this.preview) probeHost(cx);
    this.snapshot = snapshotMode();
    // The Mac's saved fleet is read while the host is not known to be local: ready when it turns out a relay.
    if (shown && !this.preview && !hostLocal()) refreshSaved(cx);
    // Shown and able to act, newly: fresh data (also when the host answered `local` after the board showed).
    const live = shown && this.live;
    const fresh = live && !this.shownLive;
    this.shownLive = live;
    if (fresh) {
      gh.opened(cx);
      scan.refreshUsage(cx);
      this.now = Date.now();
      cx.notify();
    }
    this.shown = shown;
    if (!shown || !this.live) return;
    const rows = fleet.rows();
    // The agent being answered is gone: the composer closes (never re-targets); its text stays in the field.
    if (this.replying && !rows.some((r) => r.address === this.replying)) {
      this.notice.show(cx, { tone: "warning", text: t("home.next.gone") });
      this.cancelReply(cx);
    }
    const a = this.barAgent(rows);
    if (a?.status === "blocked") ensureTail(cx, a);
  }

  focus(_cx) {
    this.handle.focus();
  }

  // Actions.

  go(cx, a) {
    if (!this.live) return;
    goTo(a.address);
    cx.notify();
  }

  goAddress(cx, address) {
    if (!this.live) return;
    goTo(address);
    cx.notify();
  }

  /** Right-click on a card: the agent beside the board; again on the same agent puts it away. */
  beside(cx, a) {
    if (!this.live) return;
    const node = layoutNode("home-agent");
    if (node && !node.hidden && fleet.current()?.address === a.address) hideInCenter("home-agent");
    else openBeside(a.address);
    cx.notify();
  }

  later(cx, a) {
    if (!this.live) return;
    snooze(a.address, "hour");
    if (this.replying === a.address) this.cancelReply(cx);
    this.notice.show(cx, { tone: "info", text: t("home.next.snoozed", { project: project(a) }), action: { label: t("home.next.undo"), onClick: (_e, cx) => (snooze(a.address, null), cx.notify()) } });
  }

  /** Opens the reply composer for the agent the bar shows now; the answer goes to that agent only. A draft left
   *  for the same agent comes back; another agent starts empty. */
  startReply(cx) {
    const a = nextUp(fleet.rows());
    if (!this.live || !a || a.status !== "blocked") return;
    if (this.draftFor !== a.address) this.replyInput.set_value("");
    // A new composer: a send of an earlier one that lands later leaves this one and its text alone.
    this.composer = (this.composer ?? 0) + 1;
    this.replying = a.address;
    this.draftFor = a.address;
    this.replyInput.focus();
    cx.notify();
  }

  cancelReply(cx) {
    if (!this.replying) return;
    this.composer = (this.composer ?? 0) + 1;
    this.replying = null;
    this.handle.focus();
    cx.notify();
  }

  /** The agent the bar shows: the one being answered while the composer is open, else the next one. */
  barAgent(rows) {
    return (this.replying && rows.find((r) => r.address === this.replying)) || nextUp(rows);
  }

  /** The agent at `address` when it still waits for an answer, else null with a notice (the typed text stays). */
  stillWaiting(cx, address) {
    const a = fleet.rows().find((r) => r.address === address);
    if (a?.status === "blocked") return a;
    this.notice.show(cx, { tone: "warning", text: a ? t("home.next.notWaiting", { tool: toolName(a), project: project(a) }) : t("home.next.gone") });
    return null;
  }

  sendReply(cx) {
    const text = this.replyInput.value().trim();
    if (!this.replying || !text || !this.live || this.sending) return;
    const a = this.stillWaiting(cx, this.replying);
    if (!a) return;
    this.sending = true;
    const composer = this.composer;
    cx.spawn(async (cx) => {
      const r = await reply(a.address, text);
      this.sending = false;
      // Sent: the draft goes when it is still the very text sent to that agent (another agent's draft, or an edited
      // one, stays), and the composer closes when it is still the one the text was sent from. Not sent: both stay,
      // for another try or a cancel.
      if (!r.error) {
        if (this.draftFor === a.address && this.replyInput.value().trim() === text) {
          this.replyInput.set_value("");
          this.draftFor = null;
        }
        if (this.composer === composer && this.replying === a.address) {
          this.replying = null;
          this.handle.focus();
        }
      }
      this.answered(cx, a, r);
    });
    cx.notify();
  }

  /** Presses choice `n` of the question drawn at `seq` (the state it was read at, captured with the choices): refused
   *  when the screen or the agent moved on since (agents.js `choose`). */
  choose(cx, a, n, seq) {
    if (!this.live || !this.stillWaiting(cx, a.address)) return;
    cx.spawn(async (cx) => this.answered(cx, a, await choose(a.address, n, seq)));
  }

  answered(cx, a, r) {
    if (r.error) this.notice.show(cx, { tone: "error", text: t("home.next.notSent"), body: r.error });
    else this.notice.show(cx, { tone: "success", text: t("home.next.sent") });
    ensureTail(cx, a, { force: true });
  }

  openRecap(cx, tab) {
    openRecap(tab);
    cx.notify();
  }

  openApp(cx, app, key) {
    openApp(app, key);
    cx.notify();
  }

  openUrl(cx, url) {
    if (url && this.live) exec("open", [url]).catch(() => {});
    cx.notify();
  }

  refreshGh(cx) {
    if (this.live) gh.refresh(cx);
    cx.notify();
  }

  toggleTodo(cx, key) {
    if (!this.live) return;
    cx.spawn(async (cx) => {
      const r = await todo.toggle(key);
      if (r.error) this.notice.show(cx, { tone: "error", text: t(`todo.error.${r.error}`) });
      else this.notice.show(cx, { tone: "success", text: t("home.strip.todoChecked"), action: { label: t("todo.undo"), onClick: (_e, cx) => cx.spawn(async () => todo.undo()) } });
    });
  }

  retryRestore(cx, addresses) {
    if (!this.live) return;
    cx.spawn(async (cx) => {
      await resume.retry(addresses);
      cx.notify();
    });
  }

  // Keys.

  key(e, cx) {
    const k = e.keystroke;
    if (this.replying) {
      if (k === "escape") {
        this.cancelReply(cx);
        return true;
      }
      return false;
    }
    if (!this.live) return false;
    const a = nextUp(fleet.rows());
    if (!a) return false;
    const tail = a.status === "blocked" ? tailOf(a.address) : null;
    const q = tail?.question;
    if (k === "enter") this.go(cx, a);
    else if (k === "t" && a.status === "blocked") this.startReply(cx);
    else if (k === "l") this.later(cx, a);
    else if (/^[1-9]$/.test(k) && q?.choices?.some((c) => c.n === Number(k))) this.choose(cx, a, Number(k), tail.seq);
    else return false;
    return true;
  }

  render(_cx) {
    const k = tokens();
    const now = Date.now();
    const drawn = boardRows(now);
    const rows = drawn.rows;
    this.snapshot = drawn.snapshot;
    this.snapshotAt = drawn.at;
    // Why the Mac's snapshot could not be read last time (its rows then are the ones read at `snapshotReadAt`).
    this.snapshotProblem = drawn.problem;
    this.snapshotReadAt = drawn.readAt;
    const a = this.barAgent(rows);
    const banner = this.notice.render("home-notice", t("common.close"));
    return ViewRoot("lz-home", { bg: k.bg.card })
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
        v_flex()
          .id("home-scroll")
          .flex_1()
          .min_h(0)
          .overflow_y_scrollbar()
          .child(
            v_flex()
              .px(22)
              .pt(16)
              .pb(18)
              .gap(14)
              .child(header(this, now))
              .when(Boolean(this.snapshot && this.snapshotProblem), (e) => e.child(snapshotNote(this, now)))
              .child(nextBar(this, a, now))
              .child(board(this, rows, now))
              .child(strip(this, now))
              .child(lower(this))
              .child(keyHints()),
          ),
      )
      .when(Boolean(banner), (e) => e.child(h_flex().absolute().left(22).right(22).bottom(14).child(banner)));
  }
}
