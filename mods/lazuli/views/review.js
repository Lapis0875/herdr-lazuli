// The Review panel (`view: "review"`, DESIGN A3): the focused agent's repository in one of three scopes
// (uncommitted, its branch against the base, its pull request), read as a diff with a file list, commented line by
// line and sent to that agent as one message, or read as a guided walkthrough (views/panels/review-walk-view.js).
// It follows the focused terminal; a focus on a panel or a file tab keeps the last one. While the panel shows it
// reads its scope again every 4 s (a pull request every 20 s); a preview copy (`props().preview`) reads nothing
// and draws the last read the panel made.
// Comments belong to the context their diff was read for (agent terminal, repository, machine, scope). A move to
// another context parks them until it comes back; Send is off while the focus differs from that context, and
// sys/review.js checks once more, right before typing, that the terminal is a live agent in that repository. A
// review never goes to another terminal or to a plain shell.
//
// Keys while it has the keyboard: j/k ↑/↓ line · [ ] file · g/G first/last · enter fold or comment · c comment ·
// e open the file · s side by side · z fold all · 1/2/3 scope · w walkthrough · ←/→ step · r read again ·
// ⇧S or ctrl-enter send. Commands: `review:scope:<s>`, `review:mode:<diff|walk>`, `review:submit`,
// `review:open:<folder>` (stays on that folder until the focus moves).

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState } from "gpui-base";
import { props, focused, checking } from "herdr";
import { t } from "../core/i18n.js";
import { tokens } from "../ui/tokens.js";
import {
  ViewRoot, Text, Icon, Spinner, Kbd, Button, IconButton, Segmented, BranchChip, PrChip, Empty, Banner, Spacer, trackFocus,
} from "../ui/kit.js";
import * as review from "../sys/review.js";
import { walkVersion, prepare } from "../sys/review-walk.js";
import { context, open as openFile } from "../sys/filetabs.js";
import { DiffView } from "./diff.js";
import { WalkBody, walkSteps } from "./panels/review-walk-view.js";
import { blockShown, agentLabel, stopPress } from "./panels/common.js";
import { Summary, FileList } from "./panels/review-parts.js";

const TICK_MS = 2000;
const LOCAL_MS = 4000;
const PR_MS = 20000;
const NARROW = 480;
const NOTICE_MS = 8000;
/** Contexts whose comments are kept while another one shows. */
const PARKED_MAX = 8;

/** A bound context's identity: the comments of one agent, repository, machine and scope. */
const ctxKey = (b) => (b ? `${b.on ?? ""}|${b.terminal ?? ""}|${b.repo}|${b.scope}` : "");

export default class Review {
  constructor(name) {
    this.name = name;
  }

  init(_props, cx) {
    this.p = props() ?? {};
    this.preview = this.p.preview === true;
    this.scope = review.SCOPES.includes(this.p.scope) ? this.p.scope : "uncommitted";
    this.mode = "diff";
    this.where = null; // {terminal, folder, on}: where the focus is
    this.fixed = null; // a folder `review:open` asked for, kept until the focus moves away from `fixedFrom`
    this.fixedFrom = null;
    // The context the shown diff and its comments belong to, set when a read is accepted: {terminal, folder, repo,
    // on, scope}. Comments go only to that terminal; another context parks them (`parked`, by context key) until
    // it comes back.
    this.bound = null;
    this.parked = new Map();
    this.sending = false;
    this.commentSeq = 0;
    this.read = null;
    this.error = null;
    this.loading = false;
    this.next = 0;
    this.step = 0;
    this.showSteps = false;
    this.filesOpen = false;
    this.notice = null;
    this.width = 420;
    this.drawnWalk = walkVersion();
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: t("review.comment.placeholder") });
    this.inputFocus = trackFocus(this.input);
    this.input.on("submit", (_e, cx) => {
      this.diff.commit();
      this.handle.focus();
      cx.notify();
    });
    this.diff = this.newDiff();
    if (!this.preview && !checking()) cx.timer.every(TICK_MS, (cx) => this.tick(cx));
  }

  close() {
    this.diff.release();
    this.input.release();
  }

  focus() {
    this.handle.focus();
  }

  newDiff() {
    const d = new DiffView("review", this.input, this.inputFocus);
    // Comment ids come from this view, not the DiffView, so they stay unique across diff resets (parked comments
    // come back into a new DiffView).
    d.newId = () => `review-${++this.commentSeq}`;
    d.onOpen = (path, line) => {
      const r = this.shownRead();
      if (!r || this.preview) return;
      openFile(`${r.repo}/${path}`, { on: r.on ?? null, pin: true, ...(line ? { line } : {}) });
    };
    return d;
  }

  resetDiff() {
    this.diff.release();
    this.diff = this.newDiff();
    this.step = 0;
  }

  /** Where the focused terminal works; a focus elsewhere (a panel, a file tab) keeps the last place. */
  follow(cx) {
    const f = focused();
    const terminal = f?.terminal ?? null;
    if (!terminal) return;
    const ctx = context();
    const folder = f.cwd ?? ctx.cwd ?? null;
    // The machine is the terminal's own: an address and its machine are never taken apart.
    const on = review.machineOf(terminal);
    const w = this.where;
    if (w && w.terminal === terminal && w.folder === folder && w.on === on) return;
    if (this.fixed && this.fixedFrom === terminal) return;
    this.fixed = null;
    this.where = { terminal, folder, on };
    if (!folder) return;
    this.next = 0;
    if (!this.preview && this.shown()) cx.timer.after(0, (cx) => this.load(cx));
  }

  shown() {
    return blockShown("review") || Boolean(this.p.overlay);
  }

  tick(cx) {
    if (walkVersion() !== this.drawnWalk) {
      this.drawnWalk = walkVersion();
      this.applyStep();
      cx.notify();
    }
    if (!this.where?.folder || this.loading || Date.now() < this.next || !this.shown()) return;
    this.load(cx);
  }

  load(cx) {
    if (this.preview || checking() || !this.where?.folder || this.loading) return;
    this.loading = true;
    const where = this.where;
    const scope = this.scope;
    const since = this.read?.scope === scope ? this.read.model.hash : null;
    cx.spawn(async (cx) => {
      let r;
      try {
        r = await review.read({ folder: where.folder, scope, on: where.on, since });
        if (r.place) await prepare(r.place);
      } catch (e) {
        r = { error: { code: "git", detail: String(e?.message ?? e) } };
      }
      this.loading = false;
      if (where !== this.where || scope !== this.scope) return cx.notify();
      if (r.error) {
        this.rebind(null, cx);
        this.error = r.error;
        this.read = null;
        this.errorRepo = r.repo ?? null;
      } else {
        const ctx = { terminal: where.terminal, folder: where.folder, repo: r.repo, on: r.on ?? null, scope };
        const moved = ctxKey(ctx) !== ctxKey(this.bound);
        // `same` is only this place's own unchanged patch (another repository's can hash alike, e.g. none).
        const same = r.same && this.read?.place === r.place;
        if (moved) this.rebind(ctx, cx);
        this.bound = ctx;
        if (moved || !same) {
          this.error = null;
          if (!same) this.read = r;
          this.diff.set(this.read.model);
          this.applyStep();
        }
      }
      this.next = Date.now() + (scope === "pr" ? PR_MS : LOCAL_MS);
      cx.notify();
    });
  }

  /** The diff moves to another context (null: none). The comments of the old one are parked under its key and
   *  the new one's come back; the diff is rebuilt when the repository changes. */
  rebind(ctx, cx) {
    const old = this.bound;
    if (old && this.diff.comments.length) {
      this.parked.delete(ctxKey(old));
      this.parked.set(ctxKey(old), this.diff.comments);
      while (this.parked.size > PARKED_MAX) this.parked.delete(this.parked.keys().next().value);
      const count = this.diff.comments.filter((c) => !c.stale).length;
      if (count) this.say(cx, "info", t("review.comment.parked", { count, agent: agentLabel(old.terminal) }));
    }
    if (old && ctx && old.repo === ctx.repo && old.on === ctx.on) {
      this.diff.comments = [];
      this.diff.composer = null;
      this.step = 0;
    } else this.resetDiff();
    this.bound = ctx;
    const key = ctxKey(ctx);
    if (ctx && this.parked.has(key)) {
      this.diff.comments = this.parked.get(key);
      this.parked.delete(key);
    }
  }

  /** Where the comments can go now: `{to: {address, repo, on, scope}}`, or `{why}`: "moved" while the focus,
   *  folder or scope differs from the context the diff was read for (a new read is on its way), "no-agent" when
   *  that terminal is not a live agent. Safe in render; review.send checks again before typing anything. */
  recipient() {
    const b = this.bound;
    if (this.preview || !b?.terminal) return { why: "no-agent" };
    const w = this.where;
    if (!this.read || !w || w.terminal !== b.terminal || (w.on ?? null) !== b.on || w.folder !== b.folder || this.scope !== b.scope) return { why: "moved" };
    // The terminal must live on the machine the changes were read on (a review of this Mac goes to a local agent).
    if (review.machineOf(b.terminal) !== (b.on ?? null)) return { why: "other-machine" };
    if (!review.isAgentTerminal(b.terminal)) return { why: "no-agent" };
    return { to: { address: b.terminal, repo: b.repo, on: b.on, scope: b.scope } };
  }

  /** What is drawn: this copy's read, else (a preview) the last read the panel made of the same place. */
  shownRead() {
    if (this.read) return this.read;
    if (!this.preview || !this.where?.folder) return null;
    const r = review.lastRead(this.where.folder, this.scope, this.where.on);
    if (r && this.diff.model !== r.model) this.diff.set(r.model);
    return r;
  }

  setScope(scope, cx) {
    if (scope === this.scope || !review.SCOPES.includes(scope)) return;
    // The diff and its comments stay bound to the old scope until the new read rebinds them (and parks them).
    this.scope = scope;
    this.read = null;
    this.error = null;
    this.step = 0;
    this.next = 0;
    this.load(cx);
  }

  setMode(mode, cx) {
    this.mode = mode === "walk" ? "walk" : "diff";
    this.applyStep();
    cx?.notify();
  }

  applyStep() {
    const steps = walkSteps(this.shownRead());
    if (this.mode !== "walk" || !steps.length) {
      this.diff.only = null;
      return;
    }
    this.step = Math.max(0, Math.min(steps.length - 1, this.step));
    this.diff.only = new Set(steps[this.step].hunks ?? []);
  }

  moveStep(by) {
    this.step += by;
    this.applyStep();
  }

  /** A message strip above the footer, gone after a few seconds. */
  say(cx, tone, text, undo = null) {
    const n = { tone, text, undo };
    this.notice = n;
    cx.timer.after(NOTICE_MS, (cx) => {
      if (this.notice !== n) return;
      this.notice = null;
      cx.notify();
    });
  }

  submit(cx) {
    if (this.sending || this.preview) return;
    // Exactly what goes out: the live comments now, each by id and revision. Stale ones are not part of it.
    const { items, sent } = this.diff.batch();
    if (!items.length) return;
    const rc = this.recipient();
    if (!rc.to) {
      this.say(cx, "error", t(`review.send.${rc.why}`));
      return cx.notify();
    }
    const key = ctxKey(this.bound);
    this.sending = true;
    cx.spawn(async (cx) => {
      let r;
      try {
        r = await review.send(rc.to, items);
      } catch {
        r = { error: "not-taken" };
      }
      this.sending = false;
      // On any refusal the comments stay where they are.
      if (r.error) this.say(cx, "error", t(`review.send.${r.error}`));
      else {
        // Only the comments that went out, still as they were sent: one edited or moved meanwhile stays.
        const gone = this.takeComments(key, (c) => sent.has(c.id) && sent.get(c.id) === (c.rev ?? 0));
        this.say(cx, "success", t("review.send.sent", { count: r.count, agent: agentLabel(rc.to.address) }), () => this.restoreComments(key, gone));
      }
      cx.notify();
    });
  }

  /** Takes the comments `pick(c)` chooses out of a context, wherever it is now (shown or parked); returns them. */
  takeComments(key, pick) {
    const split = (list) => [list.filter((c) => !pick(c)), list.filter(pick)];
    if (ctxKey(this.bound) === key) {
      const [keep, gone] = split(this.diff.comments);
      this.diff.comments = keep;
      if (gone.some((c) => c.id === this.diff.composer?.edit)) this.diff.composer = null;
      if (gone.some((c) => c.id === this.diff.anchoring)) this.diff.anchoring = null;
      return gone;
    }
    if (!this.parked.has(key)) return [];
    const [keep, gone] = split(this.parked.get(key));
    if (keep.length) this.parked.set(key, keep);
    else this.parked.delete(key);
    return gone;
  }

  /** Undo: the comments go back to their own context, shown or parked. */
  restoreComments(key, back) {
    if (!back.length) return;
    if (ctxKey(this.bound) === key) {
      this.diff.comments = [...this.diff.comments, ...back];
      this.diff.set(this.diff.model);
    } else this.parked.set(key, [...(this.parked.get(key) ?? []), ...back]);
  }

  clearComments(cx) {
    const key = ctxKey(this.bound);
    const gone = this.takeComments(key, () => true);
    if (!gone.length) return;
    this.say(cx, "info", t("review.comment.cleared", { count: gone.length }), () => this.restoreComments(key, gone));
  }

  command(c, cx) {
    if (typeof c !== "string" || !c.startsWith("review:")) return;
    const [, action, ...rest] = c.split(":");
    const arg = rest.join(":");
    if (action === "scope") this.setScope(arg, cx);
    else if (action === "mode") this.setMode(arg, cx);
    else if (action === "submit") this.submit(cx);
    else if (action === "open" && arg.startsWith("/")) {
      // A folder of this Mac: only a local terminal can receive its review; a remote one is not kept as recipient.
      const term = this.where?.terminal ?? focused()?.terminal ?? null;
      this.where = { terminal: term && review.machineOf(term) === null ? term : null, folder: arg, on: null };
      this.fixed = arg;
      this.fixedFrom = focused()?.terminal ?? null;
      this.read = null;
      this.error = null;
      this.next = 0;
      this.load(cx);
    }
    cx.notify();
  }

  key(e, cx) {
    if (this.diff.key(e)) return true;
    if (this.diff.composer) return false;
    switch (e.keystroke) {
      case "1": case "2": case "3": this.setScope(review.SCOPES[Number(e.keystroke) - 1], cx); return true;
      case "w": this.setMode(this.mode === "walk" ? "diff" : "walk"); return true;
      case "shift-s": case "ctrl-enter": this.submit(cx); return true;
      case "left": case "h": if (this.mode !== "walk") return false; this.moveStep(-1); return true;
      case "right": case "l": if (this.mode !== "walk") return false; this.moveStep(1); return true;
      case "r": this.next = 0; this.load(cx); return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Drawing

  render(cx) {
    this.follow(cx);
    const k = tokens();
    const narrow = this.width < NARROW;
    const r = this.shownRead();
    return ViewRoot("review-root")
      .relative()
      .track_focus(this.handle)
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) > 1) {
          this.width = size.width;
          cx.notify();
        }
      })
      .on_mouse_down("left", () => {
        if (!this.diff.composer) this.handle.focus();
      })
      .on_key_down((e, cx) => {
        if (this.key(e, cx)) {
          cx.stop_propagation();
          cx.notify();
        }
      })
      .child(this.head(k))
      .when(Boolean(this.where?.folder || r), (e) => e.child(this.repoRow(k, r, narrow)).child(this.bar(k, narrow)))
      .children(this.body(k, r, cx, narrow));
  }

  head(k) {
    return h_flex()
      .h(40)
      .flex_none()
      .pl(12)
      .pr(6)
      .gap(6)
      .items_center()
      .border_b_1()
      .border_color(k.line.soft)
      .child(Icon("git-compare", { size: 15, color: k.accent }))
      .child(Text(t("review.title"), { size: "sm", weight: "semibold", nowrap: true }))
      .child(Spacer())
      .when(this.loading, (e) => e.child(Spinner({ size: 14, color: k.text.tertiary, label: t("common.loading") })))
      .when(!this.preview, (e) =>
        e.child(IconButton("review-refresh", "refresh-cw", t("review.refresh"), { onClick: (_e, cx) => { this.next = 0; this.load(cx); } })),
      );
  }

  repoRow(k, r, narrow) {
    const about = r?.about ?? {};
    const name = r?.name ?? this.errorRepo?.split("/").pop() ?? this.where?.folder?.split("/").pop() ?? "";
    const pr = about.pr;
    const facts = this.scope === "branch" && about.base ? t("review.facts.branch", { base: about.base, count: about.commits ?? 0 }) : null;
    return h_flex()
      .h(34)
      .flex_none()
      .px(12)
      .gap(7)
      .items_center()
      .min_w(0)
      .child(Icon("folder-git", { size: 13, color: k.text.secondary }))
      .child(Text(name, { size: "sm", weight: "semibold", truncate: true }).flex_shrink_1())
      .when(Boolean(r?.on), (e) => e.child(Text(r.on, { size: "xs", tone: "tertiary", nowrap: true })))
      .child(Spacer())
      .when(Boolean(facts) && !narrow, (e) => e.child(Text(facts, { size: "xs", tone: "tertiary", nowrap: true })))
      .when(Boolean(pr?.number), (e) =>
        e.child(
          PrChip(pr.number, {
            id: "review-pr",
            state: pr.isDraft ? "draft" : String(pr.state ?? "").toLowerCase() === "merged" ? "merged" : "open",
            tooltip: pr.title,
            onClick: this.preview || !pr.url ? undefined : (_e, cx) => cx.open_url(pr.url),
          }),
        ),
      )
      .when(Boolean(about.branch) && about.branch !== "HEAD", (e) => e.child(BranchChip(about.branch)));
  }

  bar(k, narrow) {
    const scopes = review.SCOPES.map((s) => ({ key: s, label: t(narrow ? `review.scope.${s}.short` : `review.scope.${s}`) }));
    const modes = [
      { key: "diff", label: t("review.mode.diff"), icon: "file-diff" },
      { key: "walk", label: t("review.mode.walk"), icon: "route" },
    ];
    return h_flex()
      .h(38)
      .flex_none()
      .px(12)
      .gap(8)
      .items_center()
      .border_b_1()
      .border_color(k.line.soft)
      .child(Segmented("review-scope", scopes, this.scope, (v, cx) => { this.setScope(v, cx); cx.notify(); }, { label: t("review.scope.label") }))
      .child(Spacer())
      .child(Segmented("review-mode", modes, this.mode, (v, cx) => this.setMode(v, cx), { label: t("review.mode.label") }));
  }

  body(k, r, cx, narrow) {
    if (!this.where?.folder && !r) {
      return [Empty({ id: "review-empty", icon: "git-compare", title: t("review.empty.title"), body: t("review.empty.body") }).flex_1()];
    }
    if (this.error) return [this.errorState()];
    if (!r) {
      return [
        v_flex().flex_1().items_center().justify_center().gap(8)
          .child(this.preview ? Icon("git-compare", { size: 16, color: k.text.tertiary }) : Spinner({ size: 16 }))
          .child(Text(t(this.preview ? "review.preview.none" : "review.reading"), { size: "sm", tone: "secondary" })),
      ];
    }
    if (!r.model.files.length) {
      const clean = Empty({ id: "review-clean", icon: "circle-check", title: t("review.clean.title"), body: t(`review.clean.${this.scope}`) });
      // Comments (now on lines that are gone) and a draft stay reachable: the stale list, the composer, the footer.
      const draft = this.diff.comments.length > 0 || Boolean(this.diff.composer);
      if (!draft && !this.notice) return [clean.flex_1()];
      const out = [draft ? clean.flex_none() : clean.flex_1()];
      if (draft) out.push(this.diff.render({ narrow }));
      if (this.notice) out.push(this.noticeStrip());
      out.push(this.footer(k, narrow));
      return out;
    }
    const out = [];
    if (this.mode === "diff") {
      out.push(Summary(this, k, r));
      if (this.filesOpen) out.push(FileList(this, k, r));
      out.push(this.diff.render({ narrow }));
    } else out.push(WalkBody(this, k, r, cx));
    if (this.notice) out.push(this.noticeStrip());
    out.push(this.footer(k, narrow));
    return out;
  }

  errorState() {
    const e = this.error;
    const pr = this.scope === "pr";
    const title = t(e.code === "not-repo" ? "review.error.notRepo.title" : pr ? "review.error.pr.title" : "review.error.title");
    const body = e.code === "git" || e.code === "gh" ? e.detail : t(`review.error.${e.code === "not-repo" ? "notRepo" : e.code === "no-base" ? "noBase" : "noHistory"}`, e.vars);
    return Empty({
      id: "review-error",
      icon: e.code === "not-repo" ? "folder" : "triangle-alert",
      title,
      body,
      action: this.preview ? undefined : Button("review-retry", t("common.retry"), { size: "sm", icon: "refresh-cw", onClick: (_e, cx) => { this.next = 0; this.load(cx); } }),
    }).flex_1();
  }

  noticeStrip() {
    const n = this.notice;
    return div().flex_none().px(8).pb(6).child(
      Banner({
        id: "review-notice",
        tone: n.tone,
        title: n.text,
        actions: n.undo ? [{ id: "review-undo", label: t("review.undo"), icon: "undo", onClick: (_e, cx) => { n.undo(); this.notice = null; cx.notify(); } }] : [],
        onDismiss: (_e, cx) => { this.notice = null; cx.notify(); },
        dismissLabel: t("common.close"),
      }),
    );
  }

  footer(k, narrow) {
    const n = this.diff.review().length;
    const rc = this.recipient();
    const who = rc.to ? agentLabel(rc.to.address) : null;
    const blocked = n > 0 && !rc.to && !this.preview ? t({ moved: "review.submit.moved", "other-machine": "review.submit.otherMachine" }[rc.why] ?? "review.submit.noAgent") : null;
    const hint = (keys, what) => h_flex().flex_none().gap(4).items_center().child(Kbd(keys)).child(Text(what, { size: "xs", tone: "tertiary", nowrap: true }));
    const hints = this.diff.composer
      ? [hint("⏎", t("review.comment.add")), hint("esc", t("common.cancel"))]
      : [hint("j k", t("review.hint.line")), hint("c", t("review.hint.comment")), hint("e", t("review.hint.open"))];
    return h_flex()
      .h(44)
      .flex_none()
      .px(12)
      .gap(10)
      .items_center()
      .border_t_1()
      .border_color(k.line.soft)
      .when(!narrow && !blocked, (e) => e.children(hints))
      .when(Boolean(blocked), (e) => e.child(Text(blocked, { size: "xs", tone: "warning", truncate: true }).flex_shrink_1()))
      .child(Spacer())
      .when(this.diff.comments.length > 0 && !this.preview, (e) => e.child(Button("review-clear", t("review.clear"), { variant: "ghost", size: "sm", onClick: (_e, cx) => { this.clearComments(cx); cx.notify(); } })))
      .child(
        stopPress(
          Button("review-submit", n ? t("review.submit.count", { count: n }) : t("review.submit"), {
            variant: "primary",
            size: "sm",
            icon: "send",
            kbd: narrow ? undefined : "⇧S",
            disabled: !n || !rc.to || this.sending || this.preview,
            tooltip: who ? t("review.submit.to", { agent: who }) : blocked ?? t("review.submit.noAgent"),
            onClick: (_e, cx) => this.submit(cx),
          }),
        ),
      );
  }
}
