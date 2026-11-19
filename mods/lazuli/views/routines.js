// Routines (DESIGN A3 Routines, A6; ARCHITECTURE §4.6): every routine of data/lazuli/routines/ with its schedule, next
// and last run, running state; run now, stop, pause; its settings, problems and history (output, cost, why, worktree
// left behind); created and changed with views/routine-form.js; deleted after a confirm. Data and actions are
// sys/routines.js (T12); while a routine is selected its runs are read every 2 s (`watch`).
//
// Keys: j/k move · n new · e edit · ⏎/r run now · s stop · p pause or resume · o open the file · ⇧D delete ·
// / filter · ⌘⏎ save (form) · esc close.

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState } from "gpui-base";
import { props, run, home as homeDir } from "herdr";
import { t } from "../core/i18n.js";
import * as routines from "../sys/routines.js";
import * as runner from "../sys/runner.js";
import { open as openFile } from "../sys/filetabs.js";
import { showCenter } from "../sys/bus.js";
import { tokens } from "../ui/tokens.js";
import { ViewRoot, Text, Icon, Button, TextInput, Empty, Banner, Badge, Spacer, Spinner, trackFocus } from "../ui/kit.js";
import { Notice, Dialog, PaneHeading, LogBlock, Fact, pressFocus, inField } from "./apps/ui.js";
import { selectedIn, selectIn, revealIn } from "./apps/nav.js";
import { whenText, whyText, endText, worktreeText, stateOf, StateGlyph } from "./apps/routine-text.js";
import { ago, span, when, money, tilde } from "./apps/fmt.js";
import { RoutineForm } from "./routine-form.js";

const list = (v) => (Array.isArray(v) ? v : []);
const OUTPUT_MS = 2000;

export default class Routines {
  constructor(name) {
    this.name = name;
  }

  init(_p, cx) {
    this.live = props()?.preview !== true;
    this.run = null;
    this.output = new Map();
    this.removedTrees = new Set();
    this.confirm = null;
    this.notice = new Notice();
    this.handle = cx.focus_handle();
    this.search = InputState.new({ placeholder: t("routines.filter") });
    this.searchFocus = trackFocus(this.search);
    this.search.on("change", (_e, cx) => cx.notify());
    this.search.on("submit", (_e, cx) => (this.handle.focus(), cx.notify()));
    this.form = new RoutineForm();
    this.unwatch = null;
    this.watched = null;
    cx.timer.every(OUTPUT_MS, (cx) => this.follow(cx));
  }

  close() {
    this.unwatch?.();
  }

  focus(_cx) {
    this.handle.focus();
  }

  // The rows.

  all() {
    return list(routines.data()?.routines);
  }

  rows() {
    const words = this.search.value().toLowerCase().split(/\s+/).filter(Boolean);
    return this.all().filter((r) => words.every((w) => `${r.name} ${r.slug} ${r.whenText} ${r.prompt}`.toLowerCase().includes(w)));
  }

  /** The selected routine among those shown. A link followed from elsewhere (Home) is shown even when the filter
   *  would hide it: the filter is cleared, once per link. */
  current() {
    const req = revealIn("routines");
    if (req && req.n !== this.seenReveal && this.all().some((r) => r.slug === req.key)) {
      this.seenReveal = req.n;
      if (!this.rows().some((r) => r.slug === req.key)) this.search.set_value("");
    }
    const rows = this.rows();
    const slug = selectedIn("routines");
    return rows.find((r) => r.slug === slug) ?? rows[0] ?? null;
  }

  pick(cx, r) {
    selectIn("routines", r.slug);
    this.run = null;
    this.handle.focus();
    cx.notify();
  }

  step(cx, by) {
    const rows = this.rows();
    if (!rows.length) return;
    const at = rows.findIndex((r) => r.slug === this.current()?.slug);
    this.pick(cx, rows[Math.max(0, Math.min(rows.length - 1, (at < 0 ? 0 : at) + by))]);
  }

  /** Follows the selected routine: its runs read every 2 s, the shown run's output read while it runs. */
  follow(cx) {
    if (!this.live) return;
    const r = this.current();
    if ((r?.slug ?? null) !== this.watched) {
      this.unwatch?.();
      this.unwatch = r ? routines.watch(r.slug) : null;
      this.watched = r?.slug ?? null;
    }
    const id = this.shownRun(r)?.id;
    if (!r || !id) return;
    const key = `${r.slug}/${id}`;
    const have = this.output.get(key);
    if (have?.loading || (have && !have.running)) return;
    this.loadOutput(cx, r.slug, id);
  }

  loadOutput(cx, slug, id) {
    const key = `${slug}/${id}`;
    this.output.set(key, { ...(this.output.get(key) ?? {}), loading: true });
    cx.spawn(async (cx) => {
      const out = await routines.output(slug, id).catch(() => ({ text: "", running: false }));
      this.output.set(key, { text: out.text ?? "", running: out.running, loading: false });
      if (this.output.size > 40) this.output.delete(this.output.keys().next().value);
      cx.notify();
    });
  }

  /** The run whose output shows: the one picked, else the running one, else the last. */
  shownRun(r) {
    if (!r) return null;
    const runs = routines.history(r.slug);
    if (this.run) return runs.find((x) => x.id === this.run) ?? (r.running?.id === this.run ? { ...r.running, running: true } : null);
    if (r.running) return { ...r.running, running: true };
    return runs[0] ?? null;
  }

  // Actions.

  async act(cx, job, done) {
    if (!this.live) return;
    try {
      const r = await job();
      if (done) done(r, cx);
    } catch (e) {
      this.notice.show(cx, { tone: "error", text: t("routines.failed"), body: e?.message ?? String(e) });
    }
    cx.notify();
  }

  runNow(cx, r) {
    cx.spawn(async (cx) => this.act(cx, () => routines.runNow(r.slug), (ok, cx) => {
      this.run = null;
      if (!ok) this.notice.show(cx, { tone: "info", text: t("routines.alreadyRunning", { name: r.name }) });
    }));
  }

  stop(cx, r) {
    cx.spawn(async (cx) => this.act(cx, () => routines.stop(r.slug), (stopped, cx) => this.notice.show(cx, { tone: "info", text: stopped ? t("routines.stopping", { name: r.name }) : t("routines.dequeued", { name: r.name }) })));
  }

  pause(cx, r) {
    cx.spawn(async (cx) => this.act(cx, () => routines.pause(r.slug, !r.paused), (_ok, cx) => this.notice.show(cx, { tone: "info", text: r.paused ? t("routines.resumed", { name: r.name }) : t("routines.paused", { name: r.name }) })));
  }

  edit(cx, r) {
    if (!this.live) return;
    this.form.show(cx, r?.slug ?? null, (cx, slug, isNew) => {
      selectIn("routines", slug);
      this.notice.show(cx, { tone: "success", text: isNew ? t("routines.created") : t("routines.saved") });
      routines.poke();
    });
  }

  openFile(cx, r) {
    if (!this.live) return;
    // Routine files live on this Mac, whatever machine the shown space is on.
    openFile(r.path, { pin: true, on: null });
    showCenter("work");
    cx.notify();
  }

  askRemove(cx, r) {
    if (!this.live) return;
    this.confirm = { kind: "routine", r };
    cx.notify();
  }

  /** Whether a run's worktree is still in use: that run is going now (its routine's running entry has its id), or a
   *  running entry records the same path. git removes a clean worktree under a run that has not edited yet. */
  treeInUse(slug, rec) {
    if (rec?.running) return true;
    const path = rec?.worktree?.path;
    const running = routines.data()?.running;
    if (!running || typeof running !== "object") return false;
    return Object.entries(running).some(([s, run]) => Boolean(run) && ((s === slug && run.id === rec?.id) || (Boolean(path) && run.worktree?.path === path)));
  }

  askRemoveTree(cx, slug, rec) {
    if (!this.live || this.treeInUse(slug, rec)) return;
    this.confirm = { kind: "worktree", wt: rec.worktree, slug, rec };
    cx.notify();
  }

  confirmed(cx) {
    const c = this.confirm;
    this.confirm = null;
    if (c?.kind === "routine") {
      cx.spawn(async (cx) => this.act(cx, () => routines.remove(c.r.slug), (_ok, cx) => {
        selectIn("routines", null);
        this.notice.show(cx, { tone: "success", text: t("routines.deleted", { name: c.r.name }) });
      }));
    } else if (c?.kind === "worktree") {
      // Asked again now: the run may have started using it since the dialog opened.
      if (this.treeInUse(c.slug, c.rec)) {
        this.notice.show(cx, { tone: "warning", text: t("routines.worktree.inUse") });
        cx.notify();
        return;
      }
      cx.spawn(async (cx) => this.act(cx, () => runner.removeWorktree(c.wt), (ok, cx) => {
        if (ok) this.removedTrees.add(c.wt.path);
        this.notice.show(cx, ok ? { tone: "success", text: t("routines.worktree.removedNow") } : { tone: "warning", text: t("routines.worktree.notRemoved") });
      }));
    }
    cx.notify();
  }

  openTree(cx, wt) {
    if (!this.live) return;
    run("tab.new", { folder: wt.cwd || wt.path, name: wt.branch, focus: true });
    showCenter("work");
    cx.notify();
  }

  // Keys.

  key(e, cx) {
    const k = e.keystroke;
    if (this.form.open) return this.form.key(e, cx);
    if (this.confirm) {
      if (k === "escape") this.confirm = null;
      else if (k === "enter") this.confirmed(cx);
      else return false;
      return true;
    }
    if (this.searchFocus.focused) {
      if (k === "escape" || k === "down") {
        if (k === "escape") this.search.set_value("");
        this.handle.focus();
        return true;
      }
      return false;
    }
    const r = this.current();
    switch (k) {
      case "j":
      case "down":
        this.step(cx, 1);
        return true;
      case "k":
      case "up":
        this.step(cx, -1);
        return true;
      case "n":
      case "a":
        this.edit(cx, null);
        return true;
      case "/":
        this.search.focus();
        return true;
    }
    if (!r || !this.live) return false;
    if (k === "enter" || k === "r") this.runNow(cx, r);
    else if (k === "s" && (r.running || r.queued)) this.stop(cx, r);
    else if (k === "p") this.pause(cx, r);
    else if (k === "e") this.edit(cx, r);
    else if (k === "o") this.openFile(cx, r);
    else if (k === "shift-d") this.askRemove(cx, r);
    else return false;
    return true;
  }

  // Drawing.

  row(r, on, now) {
    const k = tokens();
    const state = stateOf(r);
    const note = r.running
      ? t("routines.row.running", { time: span(now - r.running.started) })
      : r.queued
        ? t("routines.run.queued")
        : r.paused
          ? t("routines.row.paused")
          : typeof r.next === "number"
            ? t("routines.row.next", { time: when(r.next, now) })
            : r.last
              ? t("routines.row.last", { time: ago(r.last.ended ?? r.last.started, now) })
              : t("routines.row.never");
    return h_flex()
      .id(`rt-row-${r.slug}`)
      .min_h(46)
      .px(10)
      .py(5)
      .gap(10)
      .items_center()
      .rounded(k.radius.md)
      .role("list_item")
      .aria_selected(on)
      .bg(on ? k.bg.selected : k.bg.card)
      .hover((s) => s.bg(on ? k.bg.selected : k.bg.hover))
      .cursor_pointer()
      .on_click((e, cx) => (e.click_count > 1 ? this.edit(cx, r) : this.pick(cx, r)))
      .child(StateGlyph(state))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .child(Text(r.name, { weight: on ? "medium" : undefined, truncate: true, tone: r.paused ? "secondary" : "primary" }))
          .child(Text(`${whenText(r.when)} · ${note}`, { size: "xs", tone: r.error ? "error" : "tertiary", truncate: true })),
      )
      .when(r.problems.length > 0 && !r.error, (e) => e.child(Icon("triangle-alert", { size: 12, color: k.state.warning })))
      .when(typeof r.lastCost === "number", (e) => e.child(Text(money(r.lastCost), { size: "xs", mono: true, tone: "tertiary" })));
  }

  head(r, now) {
    const busy = Boolean(r.running || r.queued);
    return v_flex()
      .gap(8)
      .child(
        h_flex()
          .gap(8)
          .items_center()
          .child(StateGlyph(stateOf(r), { size: 16 }))
          .child(Text(r.name, { size: "lg", weight: "semibold", truncate: true }).flex_1())
          .child(Badge(t(`routines.trigger-kind.${r.trigger}`), { tone: r.trigger === "broken" ? "error" : "default" })),
      )
      .child(Text(tilde(r.path, homeDir()), { size: "xs", mono: true, tone: "tertiary", truncate: true }))
      .child(
        h_flex()
          .flex_wrap()
          .gap(6)
          .child(
            busy
              ? Button("rt-stop", r.running ? t("routines.stop") : t("routines.dequeue"), { size: "sm", icon: "circle-stop", kbd: "S", disabled: !this.live, onClick: (_e, cx) => this.stop(cx, r) })
              : Button("rt-run", t("routines.runNow"), { size: "sm", variant: "primary", icon: "play", kbd: "⏎", disabled: !this.live || Boolean(r.error), onClick: (_e, cx) => this.runNow(cx, r) }),
          )
          .child(Button("rt-pause", r.paused ? t("routines.resume") : t("routines.pause"), { size: "sm", icon: r.paused ? "play" : "circle-pause", kbd: "P", disabled: !this.live, onClick: (_e, cx) => this.pause(cx, r) }))
          .child(Button("rt-edit", t("common.edit"), { size: "sm", icon: "pencil", kbd: "E", disabled: !this.live, onClick: (_e, cx) => this.edit(cx, r) }))
          .child(Button("rt-file", t("routines.openFile"), { size: "sm", variant: "ghost", icon: "file-text", kbd: "O", disabled: !this.live, onClick: (_e, cx) => this.openFile(cx, r) }))
          .child(Spacer())
          .child(Button("rt-delete", t("common.delete"), { size: "sm", variant: "ghost", icon: "trash-2", kbd: "⇧D", disabled: !this.live, onClick: (_e, cx) => this.askRemove(cx, r) })),
      );
  }

  settings(r, now) {
    const runWith = r.run === "shell" ? t("routines.form.kindShell") : [r.tool ? t(`routines.agent.${r.tool}`) : r.agent || t("routines.agent.unknown"), r.model, r.mode].filter(Boolean).join(" · ");
    const facts = [
      Fact(t("routines.fact.when"), whenText(r.when)),
      Fact(t("routines.fact.next"), r.nextRuns.length ? r.nextRuns.map((at) => when(at, now)).join(", ") : r.paused ? t("routines.row.paused") : t("routines.fact.noNext")),
      Fact(t("routines.fact.runs"), runWith),
      Fact(t("routines.fact.cwd"), r.cwd ? tilde(r.cwd, homeDir()) : r.run === "shell" ? tilde(homeDir(), homeDir()) : t("routines.fact.cwdOwn")),
      Fact(t("routines.fact.timeout"), t("routines.fact.minutes", { n: r.timeout })),
      Fact(t("routines.fact.notify"), t(`routines.notify.${r.notify}`)),
      Fact(t("routines.fact.catchUp"), r.catchUp ? span(r.catchUp * 60000) : t("routines.fact.never")),
      Fact(t("routines.fact.worktree"), r.worktree ? t("routines.fact.yes") : t("routines.fact.no")),
      Fact(t("routines.fact.spent"), typeof r.budget === "number" ? t("routines.fact.budget", { spent: money(r.spentWeek), budget: money(r.budget) }) : money(r.spentWeek)),
    ];
    if (r.tools.length) facts.splice(3, 0, Fact(t("routines.fact.tools"), r.tools.join(", ")));
    return v_flex().gap(4).child(PaneHeading(t("routines.settings"), { icon: "settings" })).children(facts);
  }

  historyRow(r, rec, on, now) {
    const k = tokens();
    const end = endText(rec, r.timeout);
    const dur = typeof rec.ended === "number" && typeof rec.started === "number" && !rec.missed ? span(rec.ended - rec.started) : "";
    return h_flex()
      .id(`rt-run-${rec.id}`)
      .min_h(40)
      .px(8)
      .py(4)
      .gap(8)
      .items_center()
      .rounded(k.radius.md)
      .bg(on ? k.bg.selected : k.bg.card)
      .hover((s) => s.bg(on ? k.bg.selected : k.bg.hover))
      .cursor_pointer()
      .on_click((_e, cx) => ((this.run = rec.id), cx.notify()))
      .child(StateGlyph(rec.running ? "running" : rec.ok ? "ok" : rec.missed ? "missed" : rec.stopped ? "paused" : "failed", { size: 13 }))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .child(Text(rec.summary || (rec.running ? t("routines.run.running") : end.text), { size: "sm", truncate: true }))
          .child(Text([when(rec.started, now), whyText(rec.why), rec.running ? null : end.text, dur].filter(Boolean).join(" · "), { size: "xs", tone: "tertiary", truncate: true })),
      )
      .when(typeof rec.cost === "number", (e) => e.child(Text(money(rec.cost), { size: "xs", mono: true, tone: "secondary" })));
  }

  runPane(r, rec) {
    const k = tokens();
    if (!rec) return null;
    const out = this.output.get(`${r.slug}/${rec.id}`);
    const lines = String(out?.text ?? "").replace(/\s+$/, "").split("\n").slice(-200);
    const wt = rec.worktree;
    const wtText = worktreeText(wt, wt ? this.removedTrees.has(wt.path) : false);
    return v_flex()
      .gap(8)
      .child(PaneHeading(rec.running ? t("routines.output.live") : t("routines.output.title"), { icon: "scroll-text", trailing: out?.loading ? [Spinner({ size: 12, color: k.text.tertiary })] : [] }))
      .when(Boolean(rec.error), (e) => e.child(Banner({ id: "rt-run-error", tone: "error", title: endText(rec, r.timeout).text })))
      .child(out?.text ? LogBlock("rt-output", lines, { maxHeight: 320, tone: "primary" }) : Text(out?.loading ? t("common.loading") : rec.missed ? t("routines.run.missed") : t("routines.output.none"), { size: "sm", tone: "tertiary" }))
      .when(Boolean(wtText), (e) =>
        e.child(
          h_flex()
            .gap(8)
            .items_center()
            .flex_wrap()
            .child(Icon("git-branch", { size: 13, color: k.text.secondary }))
            .child(Text(wtText, { size: "sm" }))
            .child(Text(wt.branch ?? "", { size: "xs", mono: true, tone: "tertiary" }).flex_1())
            .when(!wt.removed && !this.removedTrees.has(wt.path), (e2) =>
              e2
                .child(Button("rt-wt-open", t("routines.worktree.open"), { size: "sm", icon: "folder", disabled: !this.live, onClick: (_e, cx) => this.openTree(cx, wt) }))
                .child(Button("rt-wt-remove", t("routines.worktree.remove"), { size: "sm", variant: "ghost", icon: "trash-2", disabled: !this.live || this.treeInUse(r.slug, rec), tooltip: this.treeInUse(r.slug, rec) ? t("routines.worktree.inUse") : undefined, onClick: (_e, cx) => this.askRemoveTree(cx, r.slug, rec) })),
            ),
        ),
      );
  }

  /** The selected routine's pane, as the row's own flex child: a scroll area nested in one more flex_1 wrapper laid
   *  out at zero height live and drew nothing. */
  detail(r, now) {
    if (!r) return v_flex().flex_1().min_w(0).min_h(0).child(Empty({ id: "rt-none", icon: "calendar-clock", title: t("routines.none"), body: t("routines.noneBody") }));
    const runs = routines.history(r.slug);
    const shown = this.shownRun(r);
    const all = r.running ? [{ ...r.running, running: true }, ...runs] : runs;
    return v_flex()
      .id("rt-detail")
      .flex_1()
      .min_w(0)
      .min_h(0)
      .overflow_y_scrollbar()
      .child(
        v_flex()
          .p(18)
          .gap(14)
          .child(this.head(r, now))
          .when(Boolean(r.error), (e) => e.child(Banner({ id: "rt-when-error", tone: "error", title: whenText(r.when) })))
          .children(r.problems.map((p, i) => Banner({ id: `rt-problem-${i}`, tone: "warning", title: t(`routines.problem.${p}`) })))
          .when(r.over, (e) => e.child(Banner({ id: "rt-over", tone: "warning", title: t("routines.run.over-budget") })))
          .when(Boolean(r.running), (e) => e.child(Banner({ id: "rt-running", tone: "info", icon: "loader", title: t("routines.runningFor", { time: span(now - r.running.started) }), body: whyText(r.running.why) })))
          .child(this.settings(r, now))
          .child(
            v_flex()
              .gap(4)
              .child(PaneHeading(t("routines.history"), { icon: "history", count: runs.length }))
              .when(!all.length, (e) => e.child(Text(t("routines.historyNone"), { size: "sm", tone: "tertiary" })))
              .children(all.map((rec) => this.historyRow(r, rec, rec.id === shown?.id, now))),
          )
          .when(Boolean(shown), (e) => e.child(this.runPane(r, shown)))
          .child(v_flex().gap(4).child(PaneHeading(r.run === "shell" ? t("routines.form.script") : t("routines.form.prompt"), { icon: "file-text" })).child(LogBlock("rt-prompt", String(r.prompt ?? "").split("\n"), { maxHeight: 200, tone: "secondary" }))),
      );
  }

  confirmEl() {
    const c = this.confirm;
    const isRoutine = c.kind === "routine";
    return Dialog({
      id: "rt-confirm",
      title: isRoutine ? t("routines.deleteTitle", { name: c.r.name }) : t("routines.worktree.removeTitle"),
      body: Text(isRoutine ? t("routines.deleteBody") : t("routines.worktree.removeBody", { path: tilde(c.wt.path, homeDir()) }), { size: "sm", tone: "secondary" }).whitespace_normal(),
      dismissLabel: t("common.close"),
      onDismiss: (_e, cx) => ((this.confirm = null), cx.notify()),
      actions: [
        { id: "rt-confirm-no", label: t("common.cancel"), variant: "ghost", kbd: "esc", onClick: (_e, cx) => ((this.confirm = null), cx.notify()) },
        { id: "rt-confirm-yes", label: isRoutine ? t("common.delete") : t("routines.worktree.remove"), variant: "primary", icon: "trash-2", kbd: "⏎", onClick: (_e, cx) => this.confirmed(cx) },
      ],
    });
  }

  render(_cx) {
    const k = tokens();
    const now = Date.now();
    const d = routines.data();
    const rows = this.rows();
    const cur = this.current();
    const running = this.all().filter((r) => r.running).length;
    const banner = this.notice.render("rt-notice", t("common.close"));
    const body = !d
      ? Empty({ id: "rt-loading", icon: "calendar-clock", title: t("common.loading") })
      : !this.all().length
        ? Empty({ id: "rt-empty", icon: "calendar-clock", title: t("routines.empty"), body: t("routines.emptyBody"), action: this.live ? Button("rt-empty-new", t("routines.new"), { variant: "primary", icon: "plus", kbd: "N", onClick: (_e, cx) => this.edit(cx, null) }) : null })
        : h_flex()
            .flex_1()
            .min_h(0)
            .child(
              v_flex()
                .id("rt-list")
                .w(400)
                .flex_none()
                .min_h(0)
                .p(8)
                .gap(1)
                .overflow_y_scrollbar()
                .role("list")
                .accessibility_label(t("routines.title"))
                .when(!rows.length, (e) => e.child(Empty({ id: "rt-nomatch", icon: "search", title: t("routines.noMatch") })))
                .children(rows.map((r) => this.row(r, r.slug === cur?.slug, now))),
            )
            .child(div().w(1).h_full().bg(k.line.soft))
            .child(this.detail(cur, now));
    return ViewRoot("lz-routines", { bg: k.bg.card })
      .relative()
      .track_focus(this.handle)
      .on_mouse_down("left", pressFocus(this, () => this.form.open))
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
          .child(Icon("calendar-clock", { size: 18, color: k.text.secondary }))
          .child(Text(t("routines.title"), { size: "xl", weight: "semibold", nowrap: true }))
          .child(Text(running ? t("routines.summaryRunning", { n: this.all().length, running }) : t("routines.summary", { n: this.all().length }), { tone: "secondary", nowrap: true }))
          .child(div().w(220).child(inField(this, TextInput(this.search, { id: "rt-search", focused: this.searchFocus.focused, icon: "search", a11y: t("routines.filter") }))))
          .child(Spacer())
          .child(Button("rt-new", t("routines.new"), { variant: "primary", icon: "plus", kbd: "N", disabled: !this.live, onClick: (_e, cx) => this.edit(cx, null) })),
      )
      .child(div().h(1).w_full().flex_none().bg(k.line.soft))
      .child(v_flex().flex_1().min_h(0).child(body))
      .when(Boolean(banner), (e) => e.child(div().flex_none().px(22).py(8).child(banner)))
      .when(Boolean(this.confirm), (e) => e.child(this.confirmEl()))
      .when(this.form.open, (e) => e.child(this.form.render()));
  }
}
