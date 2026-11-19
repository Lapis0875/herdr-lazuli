// The Inbox (DESIGN A3 Inbox, ARCHITECTURE §4.1): GitHub through sys/gh.js only. Grouped rows on the left (review
// requests asked of me, then of my teams; CI failures of my PRs; my other PRs; merged these 30 days), the selected
// row's details and actions on the right (views/inbox-detail.js). The empty, not-signed-in, rate-limited and relay
// states come from the store's `error` and gh.state(). When it is shown it asks for fresh data (gh.opened).
//
// Keys: j/k move · o open · m merge · r rerun failed jobs · p plan · s send to an agent · ⇧R refresh · / filter ·
// z fold the merged · esc clear.

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState } from "gpui-base";
import { props, exec } from "herdr";
import { t } from "../core/i18n.js";
import * as gh from "../sys/gh.js";
import * as fleet from "../sys/fleet.js";
import * as queue from "../sys/queue.js";
import { debugLog } from "../sys/store.js";
import { activeChild } from "../sys/bus.js";
import { NODE } from "../sys/state.js";
import { tokens } from "../ui/tokens.js";
import { ViewRoot, Text, Icon, Button, IconButton, TextInput, Empty, Banner, Badge, Segmented, Spacer, Spinner, trackFocus } from "../ui/kit.js";
import { Notice, Dialog, pressFocus, inField } from "./apps/ui.js";
import { selectedIn, selectIn, revealIn } from "./apps/nav.js";
import { groups, attentionCount, agentPrompt, runFor } from "./apps/inbox-model.js";
import { Mark, toolName, project, taskOf, send } from "./apps/agents.js";
import { probeHost, hostLocal } from "./apps/snapshot.js";
import { ago, span, threadCount } from "./apps/fmt.js";
import { syncLine } from "./apps/home-board.js";
import { DetailPane, ensureDetails, detailsFor, startPlan, planText, startAgent } from "./inbox-detail.js";

const WATCH_MS = 3000;
const METHODS = ["auto", "squash", "merge", "rebase"];
/** How GitHub refuses a merge whose pinned head (`--match-head-commit`) is no longer the PR's head. */
const HEAD_MOVED = /head (?:branch|commit|sha|ref)\b.*(?:modified|changed|match)|match-head-commit|expected head|head.*(?:was|has been) (?:modified|updated)/i;
const short = (sha) => String(sha ?? "").slice(0, 7);
const GROUP_ICON = { direct: "user", team: "users", ci: "circle-x", mine: "git-pull-request", merged: "git-merge" };

export default class Inbox {
  constructor(name) {
    this.name = name;
  }

  /** Acts only as the layout's own copy on a host that runs commands: never as a preview, never on a herdr-relay device
   *  (the same host check as Home), where details, plans, reruns and agents cannot run. */
  get live() {
    return !this.preview && hostLocal();
  }

  init(_p, cx) {
    this.preview = props()?.preview === true;
    if (!this.preview) probeHost(cx);
    // The reveal request last handled: a link followed from elsewhere (Home) is shown once (see reveal), also the one
    // that opened this copy.
    this.seenReveal = 0;
    this.folded = new Set(["merged"]);
    this.dialog = null;
    this.busy = false;
    this.shown = false;
    this.notice = new Notice(8000);
    this.handle = cx.focus_handle();
    this.search = InputState.new({ placeholder: t("inbox.filter") });
    this.searchFocus = trackFocus(this.search);
    this.search.on("change", (_e, cx) => cx.notify());
    this.search.on("submit", (_e, cx) => (this.handle.focus(), cx.notify()));
    // Saved data (read only) loads whatever the host turns out to be; details, actions and keys wait for `live`.
    gh.load();
    cx.timer.every(WATCH_MS, (cx) => this.watch(cx));
    this.watch(cx);
  }

  focus(_cx) {
    this.handle.focus();
  }

  /** Becoming shown asks gh for fresh data; the selected row's details are kept fetched. */
  watch(cx) {
    const shown = activeChild(NODE.center) === "inbox";
    if (!this.preview) probeHost(cx);
    // Shown and able to act, newly (also when the host answered `local` after the Inbox showed): fresh data.
    const live = shown && this.live;
    if (live && !this.shownLive) gh.opened(cx);
    this.shownLive = live;
    this.shown = shown;
    if (shown && this.live) {
      const it = this.current();
      if (it) ensureDetails(cx, it);
    }
    // A merge dialog waiting for the head commit takes it once GitHub reported one it has not refused.
    const d = this.dialog;
    if (d?.kind === "merge" && !d.head) {
      const head = gh.headOf(d.it.pr);
      if (head && head !== d.rejected) {
        d.head = head;
        cx.notify();
      }
    }
  }

  // The rows.

  matches(it) {
    const words = this.search.value().toLowerCase().split(/\s+/).filter(Boolean);
    const hay = [it.pr.title, it.pr.repo, it.pr.slug, it.pr.branch, it.pr.author, `#${it.pr.number}`].join(" ").toLowerCase();
    return words.every((w) => hay.includes(w));
  }

  groups() {
    const filtering = this.search.value().trim() !== "";
    return groups(gh.data()).map((g) => ({ ...g, items: g.items.filter((it) => this.matches(it)), open: filtering || !this.folded.has(g.group) }));
  }

  /** The rows the selection can stop on, in order. */
  visible() {
    return this.groups().flatMap((g) => (g.open ? g.items : []));
  }

  /** The selected row among the rows shown (a filter or a folded group hides the others), else the first shown: the
   *  detail pane and every action follow it, never a row the list does not show. */
  current() {
    const rows = this.visible();
    const key = selectedIn("inbox");
    return rows.find((r) => r.key === key) ?? rows[0] ?? null;
  }

  /** A row linked from elsewhere (Home) is shown: the filter is cleared and its group unfolded when they hide it. Once
   *  per link followed, after the data holds the row. */
  reveal() {
    const req = revealIn("inbox");
    if (!req || req.n === this.seenReveal) return;
    const g = groups(gh.data()).find((x) => x.items.some((it) => it.key === req.key));
    if (!g) return;
    this.seenReveal = req.n;
    if (this.visible().some((r) => r.key === req.key)) return;
    if (this.search.value()) this.search.set_value("");
    this.folded.delete(g.group);
  }

  pick(cx, it) {
    selectIn("inbox", it.key);
    if (this.live) ensureDetails(cx, it);
    this.handle.focus();
    cx.notify();
  }

  step(cx, by) {
    const rows = this.visible();
    if (!rows.length) return;
    const at = rows.findIndex((r) => r.key === this.current()?.key);
    this.pick(cx, rows[Math.max(0, Math.min(rows.length - 1, (at < 0 ? 0 : at) + by))]);
  }

  fold(cx, group) {
    if (!this.folded.delete(group)) this.folded.add(group);
    cx.notify();
  }

  // Actions.

  open(cx, it) {
    if (it?.pr?.url && this.live) exec("open", [it.pr.url]).catch(() => {});
    cx.notify();
  }

  refresh(cx) {
    if (this.live) gh.refresh(cx);
    cx.notify();
  }

  /** The merge dialog pins the head commit it shows: the merge goes through only for that commit. */
  askMerge(cx, it) {
    if (!this.live || it.pr.isDraft) return;
    const head = gh.headOf(it.pr);
    this.dialog = { kind: "merge", it, method: "auto", head, rejected: null, changedFrom: null };
    if (!head) gh.refresh(cx);
    cx.notify();
  }

  merge(cx) {
    const d = this.dialog;
    if (!this.live || d?.kind !== "merge" || !d.head || this.busy) return;
    // New commits since the dialog showed its commit: no merge; the dialog shows the new one to confirm again.
    const now = gh.headOf(d.it.pr);
    if (now && now !== d.head) {
      d.changedFrom = d.head;
      d.head = now;
      cx.notify();
      return;
    }
    const head = d.head;
    this.dialog = null;
    this.busy = true;
    cx.spawn(async (cx) => {
      const r = await gh.merge(d.it.pr, { ...(d.method === "auto" ? {} : { method: d.method }), head });
      this.busy = false;
      if (r.error && HEAD_MOVED.test(r.error.message ?? "")) {
        // GitHub refused the pinned commit: ask again once the new head is known.
        this.dialog = { ...d, head: null, rejected: head, changedFrom: head };
        gh.refresh(cx);
        this.notice.show(cx, { tone: "warning", text: t("inbox.merge.headMoved") });
      } else if (r.error) {
        this.notice.show(cx, { tone: "error", text: t("inbox.merge.failed"), body: r.error.kind === "no-method" ? t("inbox.merge.noMethod") : r.error.message });
      } else {
        this.notice.show(cx, { tone: "success", text: t("inbox.merge.done", { ref: `#${d.it.pr.number}`, sha: short(r.head ?? head), method: t(`inbox.merge.method.${r.method}`) }) });
      }
      cx.notify();
    });
    cx.notify();
  }

  /** Reruns the failed jobs of the row's own run (sys/gh.js `runOf`, asked now, never another PR's on a same-named
   *  branch). */
  rerun(cx, it) {
    const ciRun = runFor(it);
    if (!this.live || !ciRun?.workflowId || ciRun.isRunning) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      const r = await gh.rerun(ciRun);
      this.busy = false;
      if (r.error) this.notice.show(cx, { tone: "error", text: t("inbox.rerun.failed"), body: r.error.message });
      else this.notice.show(cx, { tone: "success", text: t("inbox.rerun.done", { n: r.runs.length }) });
    });
    cx.notify();
  }

  plan(cx, it) {
    if (!this.live || it.kind === "merged") return;
    startPlan(cx, it);
    cx.notify();
  }

  startAgent(cx, it) {
    if (!this.live) return;
    this.dialog = null;
    startAgent(cx, it);
    cx.notify();
  }

  askSend(cx, it) {
    if (!this.live) return;
    this.dialog = { kind: "send", it };
    cx.notify();
  }

  /** Types the row's prompt into an agent; one that does not take it can queue it instead. */
  send(cx, address) {
    const d = this.dialog;
    if (!this.live || d?.kind !== "send") return;
    this.dialog = null;
    const prompt = agentPrompt(d.it, detailsFor(d.it), planText(d.it.key));
    cx.spawn(async (cx) => {
      const r = await send(address, prompt);
      if (!r.error) {
        this.notice.show(cx, { tone: "success", text: t("inbox.send.done", { name: taskOf(fleet.rows().find((a) => a.address === address) ?? { address }) }) });
        return;
      }
      this.notice.show(cx, {
        tone: "warning",
        text: t("inbox.send.notTaken"),
        body: r.error,
        action: { label: t("inbox.send.queue"), onClick: (_e, cx) => cx.spawn(async (cx) => this.queued(cx, await queue.add(address, prompt))) },
      });
    });
    cx.notify();
  }

  queued(cx, r) {
    this.notice.show(cx, r.error ? { tone: "error", text: t(`home.queue.error.${r.error}`) } : { tone: "success", text: t("inbox.send.queued") });
  }

  // Keys.

  key(e, cx) {
    const k = e.keystroke;
    if (this.dialog) {
      if (k === "escape") {
        this.dialog = null;
        return true;
      }
      if (k === "enter" && this.dialog.kind === "merge") {
        this.merge(cx);
        return true;
      }
      return false;
    }
    if (this.searchFocus.focused) {
      if (k === "escape" || k === "down") {
        if (k === "escape") this.search.set_value("");
        this.handle.focus();
        return true;
      }
      return false;
    }
    const it = this.current();
    switch (k) {
      case "j":
      case "down":
        this.step(cx, 1);
        return true;
      case "k":
      case "up":
        this.step(cx, -1);
        return true;
      case "shift-r":
        this.refresh(cx);
        return true;
      case "/":
        this.search.focus();
        return true;
      case "z":
        this.fold(cx, "merged");
        return true;
      case "escape":
        this.search.set_value("");
        return true;
    }
    if (!it) return false;
    if (k === "o" || k === "enter") this.open(cx, it);
    else if (k === "m" && (it.kind === "mine" || it.kind === "ci")) this.askMerge(cx, it);
    else if (k === "r" && runFor(it)?.workflowId) this.rerun(cx, it);
    else if (k === "p") this.plan(cx, it);
    else if (k === "s") this.askSend(cx, it);
    else return false;
    return true;
  }

  // Drawing.

  row(it, on) {
    const k = tokens();
    const pr = it.pr;
    const tone = it.kind === "ci" ? k.state.error : it.kind === "merged" ? k.state.done : it.kind === "review" && pr.isDirect ? k.state.blocked : k.text.secondary;
    const icon = it.kind === "ci" ? "circle-x" : it.kind === "merged" ? "git-merge" : pr.isDraft ? "git-pull-request-draft" : "git-pull-request";
    const meta = [
      `${pr.repo}#${pr.number}`,
      it.kind === "review" ? pr.authorName || pr.author : null,
      it.kind === "ci" ? runFor(it)?.failed?.job ?? (pr.failedChecks ?? [])[0] : null,
      it.kind === "mine" ? (pr.review === "APPROVED" ? t("home.chip.approved") : pr.review === "CHANGES_REQUESTED" ? t("home.chip.changes") : t("inbox.chip.awaiting")) : null,
      (it.kind === "mine" || it.kind === "ci") && pr.threads > 0 ? t("home.chip.threads", { n: threadCount(pr) }) : null,
      it.kind === "merged" ? ago(Date.parse(pr.mergedAt)) : pr.updatedAt ? ago(Date.parse(pr.updatedAt)) : null,
    ].filter(Boolean);
    return h_flex()
      .id(`ib-row-${it.key}`)
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
      .on_click((e, cx) => (e.click_count > 1 ? this.open(cx, it) : this.pick(cx, it)))
      .child(Icon(icon, { size: 14, color: tone }))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .child(Text(pr.title || pr.branch || "", { weight: on ? "medium" : undefined, truncate: true }))
          .child(Text(meta.join(" · "), { size: "xs", tone: "tertiary", truncate: true })),
      )
      .when(it.kind === "review" && pr.isDraft, (e) => e.child(Badge(t("inbox.chip.draft"), { variant: "text", tone: "tertiary" })))
      .when(pr.ci === "FAILURE" || pr.ci === "ERROR", (e) => e.child(Icon("circle-x", { size: 12, color: k.state.error })))
      .when(pr.ci === "SUCCESS" && it.kind !== "merged", (e) => e.child(Icon("circle-check", { size: 12, color: k.state.success })));
  }

  list(cur) {
    const k = tokens();
    const gs = this.groups();
    const out = [];
    for (const g of gs) {
      if (!g.items.length && g.group !== "direct") continue;
      out.push(
        h_flex()
          .id(`ib-group-${g.group}`)
          .h(28)
          .mt(out.length ? 8 : 0)
          .px(6)
          .gap(7)
          .items_center()
          .rounded(k.radius.sm)
          .cursor_pointer()
          .hover((s) => s.bg(k.bg.hover))
          .on_click((_e, cx) => this.fold(cx, g.group))
          .child(Icon(g.open ? "chevron-down" : "chevron-right", { size: 12, color: k.text.tertiary }))
          .child(Icon(GROUP_ICON[g.group], { size: 13, color: g.group === "ci" ? k.state.error : g.group === "direct" ? k.state.blocked : k.text.secondary }))
          .child(Text(t(`inbox.group.${g.group}`), { size: "sm", weight: "semibold", nowrap: true }))
          .child(Text(String(g.items.length), { size: "sm", mono: true, tone: "tertiary" })),
      );
      if (!g.open) continue;
      if (!g.items.length) out.push(div().px(32).py(4).child(Text(t(`inbox.group.${g.group}.empty`), { size: "sm", tone: "tertiary" })));
      out.push(...g.items.map((it) => this.row(it, it.key === cur?.key)));
    }
    const bots = gh.data()?.botRepos ?? [];
    if (bots.length) out.push(div().px(10).pt(10).child(Text(t("inbox.bots", { n: bots.length, repos: [...new Set(bots)].slice(0, 4).join(", ") }), { size: "xs", tone: "tertiary" })));
    return out;
  }

  /** The state strip above the list: not signed in, rate limited, a device, a failed poll. */
  state(now) {
    const d = gh.data();
    const s = gh.state();
    const err = d?.error;
    if (err?.kind === "relay") return Banner({ id: "ib-relay", tone: "info", title: t("inbox.state.relay") });
    if (err?.kind === "rate" || s.pausedUntil > now) return Banner({ id: "ib-rate", tone: "warning", title: t("inbox.state.rate"), body: s.pausedUntil > now ? t("inbox.state.rateUntil", { time: span(s.pausedUntil - now) }) : undefined });
    if (err && err.kind !== "auth" && typeof d?.at === "number") return Banner({ id: "ib-err", tone: "warning", title: t("inbox.state.failed"), body: err.message, actions: this.live ? [{ id: "ib-err-retry", label: t("common.retry"), onClick: (_e, cx) => this.refresh(cx) }] : [] });
    return null;
  }

  body(cur) {
    const d = gh.data();
    const err = d?.error;
    if (err?.kind === "auth") {
      return Empty({ id: "ib-auth", icon: "triangle-alert", title: t("inbox.state.auth"), body: t("inbox.state.authBody"), action: this.live ? Button("ib-auth-retry", t("inbox.refresh"), { icon: "refresh-cw", onClick: (_e, cx) => this.refresh(cx) }) : null });
    }
    if (!d || typeof d.at !== "number") {
      if (err) return Empty({ id: "ib-fail", icon: "circle-x", title: t("inbox.state.failed"), body: err.message, action: this.live ? Button("ib-fail-retry", t("common.retry"), { icon: "refresh-cw", onClick: (_e, cx) => this.refresh(cx) }) : null });
      return Empty({ id: "ib-loading", icon: "inbox", title: t("inbox.state.loading") });
    }
    const all = groups(d).reduce((n, g) => n + g.items.length, 0);
    if (!all) return Empty({ id: "ib-empty", icon: "inbox", title: t("inbox.state.empty"), body: t("inbox.state.emptyBody") });
    if (this.search.value().trim() && !this.visible().length) return Empty({ id: "ib-nomatch", icon: "search", title: t("inbox.state.noMatch") });
    // The detail pane is the row's own flex child: a scroll area (overflow_y_scrollbar) nested in one more flex_1
    // wrapper laid out at zero height live and drew nothing.
    return h_flex()
      .flex_1()
      .min_h(0)
      .child(v_flex().id("ib-list").w(420).flex_none().min_h(0).px(8).py(8).gap(1).overflow_y_scrollbar().role("list").accessibility_label(t("inbox.title")).children(this.list(cur)))
      .child(div().w(1).h_full().bg(tokens().line.soft))
      .child(this.detail(cur));
  }

  /** The selected row's pane. A build that throws is logged with its stack (debug.log) and shown as an error, never as
   *  a silently empty pane. */
  detail(cur) {
    try {
      return DetailPane(this, cur);
    } catch (e) {
      debugLog("inbox", `detail pane for ${cur?.key ?? "none"} failed: ${e?.stack ?? e}`);
      return v_flex().flex_1().min_w(0).min_h(0).child(Empty({ id: "ib-detail-failed", icon: "circle-x", title: t("inbox.detail.broken"), body: String(e?.message ?? e) }));
    }
  }

  dialogEl() {
    const d = this.dialog;
    const k = tokens();
    if (d.kind === "merge") {
      const pr = d.it.pr;
      const now = gh.headOf(pr);
      const moved = Boolean(d.head && now && now !== d.head);
      return Dialog({
        id: "ib-merge-dlg",
        title: t("inbox.merge.title", { ref: `${pr.repo}#${pr.number}` }),
        dismissLabel: t("common.close"),
        onDismiss: (_e, cx) => ((this.dialog = null), cx.notify()),
        body: v_flex()
          .gap(10)
          .child(Text(pr.title, { tone: "secondary" }).whitespace_normal())
          .child(Text(t("inbox.merge.into", { base: pr.base ?? "main", branch: pr.branch ?? "" }), { size: "sm", tone: "tertiary" }))
          .child(
            d.head
              ? h_flex().gap(6).items_center().child(Icon("git-branch", { size: 13, color: k.text.secondary })).child(Text(t("inbox.merge.commit", { sha: short(d.head) }), { size: "sm", mono: true }))
              : h_flex().gap(6).items_center().child(Spinner({ size: 12, label: t("inbox.merge.headLoading") })).child(Text(t("inbox.merge.headLoading"), { size: "sm", tone: "secondary" })),
          )
          .when(Boolean(d.changedFrom && d.head && !moved), (e) => e.child(Banner({ id: "ib-merge-changed", tone: "warning", title: t("inbox.merge.changed", { old: short(d.changedFrom), sha: short(d.head) }) })))
          .when(moved, (e) => e.child(Banner({ id: "ib-merge-moved", tone: "warning", title: t("inbox.merge.newCommits", { sha: short(now) }) })))
          .when(pr.review !== "APPROVED" || pr.ci !== "SUCCESS", (e) => e.child(Banner({ id: "ib-merge-warn", tone: "warning", title: t("inbox.merge.notReady") })))
          .child(Segmented("ib-merge-method", METHODS.map((m) => ({ key: m, label: t(`inbox.merge.method.${m}`) })), d.method, (key, cx) => ((d.method = key), cx.notify()), { label: t("inbox.merge.methodLabel") })),
        actions: [
          { id: "ib-merge-cancel", label: t("common.cancel"), variant: "ghost", kbd: "esc", onClick: (_e, cx) => ((this.dialog = null), cx.notify()) },
          {
            id: "ib-merge-ok",
            label: moved ? t("inbox.merge.useNew", { sha: short(now) }) : t("inbox.action.merge"),
            variant: "primary",
            icon: "git-merge",
            kbd: "⏎",
            disabled: !d.head || this.busy,
            onClick: (_e, cx) => this.merge(cx),
          },
        ],
      });
    }
    const agents = fleet.rows();
    const slug = String(d.it.pr.slug ?? "").toLowerCase();
    const ranked = [...agents].sort((a, b) => Number(b.branch === d.it.pr.branch) - Number(a.branch === d.it.pr.branch) || Number(String(b.slug ?? "").toLowerCase() === slug) - Number(String(a.slug ?? "").toLowerCase() === slug));
    return Dialog({
      id: "ib-send-dlg",
      width: 520,
      title: t("inbox.send.title", { ref: `#${d.it.pr.number}` }),
      dismissLabel: t("common.close"),
      onDismiss: (_e, cx) => ((this.dialog = null), cx.notify()),
      body: v_flex()
        .gap(4)
        .child(Text(t("inbox.send.body"), { size: "sm", tone: "secondary" }).whitespace_normal())
        .when(Boolean(planText(d.it.key)), (e) => e.child(Text(t("inbox.send.withPlan"), { size: "xs", tone: "tertiary" })))
        .child(
          v_flex()
            .id("ib-send-list")
            .max_h(280)
            .mt(6)
            .gap(1)
            .overflow_y_scrollbar()
            .when(!ranked.length, (e) => e.child(Text(t("home.queue.noAgent"), { size: "sm", tone: "tertiary" })))
            .children(
              ranked.map((a) =>
                h_flex()
                  .id(`ib-send-${a.address}`)
                  .h(34)
                  .px(8)
                  .gap(8)
                  .items_center()
                  .rounded(k.radius.md)
                  .cursor_pointer()
                  .hover((s) => s.bg(k.bg.hover))
                  .on_click((_e, cx) => this.send(cx, a.address))
                  .child(Mark(a))
                  .child(Text(taskOf(a), { size: "sm", truncate: true }).flex_1())
                  .child(Text(`${toolName(a)} · ${project(a)}`, { size: "xs", tone: "tertiary", nowrap: true }))
                  .when(a.branch === d.it.pr.branch, (e) => e.child(Badge(t("inbox.send.sameBranch"), { tone: "accent" }))),
              ),
            ),
        ),
      actions: [
        { id: "ib-send-new", label: t("inbox.plan.newAgent"), icon: "play", onClick: (_e, cx) => this.startAgent(cx, d.it) },
        { id: "ib-send-cancel", label: t("common.cancel"), variant: "ghost", kbd: "esc", onClick: (_e, cx) => ((this.dialog = null), cx.notify()) },
      ],
    });
  }

  render(_cx) {
    const k = tokens();
    const now = Date.now();
    const d = gh.data();
    this.reveal();
    const cur = d ? this.current() : null;
    const sync = syncLine(now);
    const banner = this.notice.render("ib-notice", t("common.close"));
    const strip = this.state(now);
    return ViewRoot("lz-inbox", { bg: k.bg.card })
      .relative()
      .track_focus(this.handle)
      .on_mouse_down("left", pressFocus(this))
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
          .child(Icon("inbox", { size: 18, color: k.text.secondary }))
          .child(Text(t("inbox.title"), { size: "xl", weight: "semibold", nowrap: true }))
          .child(Text(t("inbox.waiting", { n: attentionCount(d) }), { tone: "secondary", nowrap: true }))
          .child(div().w(220).child(inField(this, TextInput(this.search, { id: "ib-search", focused: this.searchFocus.focused, icon: "search", a11y: t("inbox.filter") }))))
          .child(Spacer())
          .when(gh.state().polling, (e) => e.child(Spinner({ size: 12, color: k.text.tertiary, label: t("home.sync.polling") })))
          .child(Text(sync.text, { size: "sm", tone: sync.tone, nowrap: true }))
          .child(IconButton("ib-refresh", "refresh-cw", t("inbox.refresh"), { disabled: !this.live, onClick: (_e, cx) => this.refresh(cx) })),
      )
      .when(Boolean(strip), (e) => e.child(div().flex_none().px(22).pb(8).child(strip)))
      .child(div().h(1).w_full().flex_none().bg(k.line.soft))
      .child(v_flex().flex_1().min_h(0).child(this.body(cur)))
      .when(Boolean(banner), (e) => e.child(div().flex_none().px(22).py(8).child(banner)))
      .when(Boolean(this.dialog), (e) => e.child(this.dialogEl()));
  }
}
