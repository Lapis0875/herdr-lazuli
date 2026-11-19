// Home's top half (mockup docs/mockups/a-lapis/home.html): the heading with the GitHub sync and the Recap button, the
// next-action bar (the longest-waiting agent's question, answered in place or put off), and the four-column stage
// board of agents with their PR and CI chips. `v` is the Home view: its state and actions.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { t } from "../../core/i18n.js";
import * as gh from "../../sys/gh.js";
import { tokens } from "../../ui/tokens.js";
import { Text, Spacer, Icon, Button, Card, SectionHeader, EmptySlot, TextInput, Kbd, Spinner, Badge, Banner } from "../../ui/kit.js";
import { STAGE_META, STAGE_ORDER, Mark, toolName, project, taskOf, elapsed, chipsOf, needsReason, inStage, tailOf } from "./agents.js";
import { ago, longDate, span } from "./fmt.js";
import { inField } from "./ui.js";

/** Cards a column shows before "N more". */
const PER_COLUMN = 6;

/** How the GitHub data stands, in a few words, and its tone. */
export function syncLine(now) {
  const d = gh.data();
  const s = gh.state();
  const err = d?.error;
  if (err?.kind === "auth") return { text: t("home.sync.auth"), tone: "warning" };
  if (err?.kind === "relay") return { text: t("home.sync.relay"), tone: "tertiary" };
  if (s.pausedUntil > now) return { text: t("home.sync.rate", { time: span(s.pausedUntil - now) }), tone: "warning" };
  if (s.polling) return { text: t("home.sync.polling"), tone: "tertiary" };
  if (err && typeof d?.at !== "number") return { text: t("home.sync.failed"), tone: "error" };
  if (typeof d?.at === "number") return { text: t("home.sync.at", { time: ago(d.at, now) }), tone: err ? "warning" : "tertiary" };
  return { text: t("home.sync.never"), tone: "tertiary" };
}

export function header(v, now) {
  const k = tokens();
  const sync = syncLine(now);
  return h_flex()
    .flex_none()
    .gap(12)
    .items_center()
    .child(Text(t("home.title"), { size: "xl", weight: "semibold", nowrap: true }))
    .child(Text(longDate(now), { tone: "secondary", nowrap: true }))
    .child(Spacer())
    .child(
      h_flex()
        .id("home-sync")
        .gap(6)
        .items_center()
        .px(6)
        .h(k.control.sm)
        .rounded(k.radius.md)
        .cursor_pointer()
        .hover((s) => s.bg(k.bg.hover))
        .tooltip(t("home.sync.refresh"))
        .accessibility_label(`${sync.text}. ${t("home.sync.refresh")}`)
        .on_click((_e, cx) => v.refreshGh(cx))
        .when(sync.tone === "tertiary" && gh.state().polling, (e) => e.child(Spinner({ size: 12, color: k.text.tertiary })))
        .child(Text(sync.text, { size: "sm", tone: sync.tone, nowrap: true })),
    )
    .when(v.snapshot && !staleSnapshot(v), (e) => e.child(Badge(v.snapshotAt ? t("home.snapshot.at", { time: ago(v.snapshotAt, now) }) : t("home.snapshot"), { tone: "info", icon: "eye" })))
    .when(staleSnapshot(v), (e) => e.child(Badge(t("home.snapshot.stale"), { tone: "warning", icon: "triangle-alert" })))
    .when(!v.snapshot, (e) => e.child(Button("home-recap", t("home.recap"), { variant: "ghost", icon: "sparkles", kbd: "⌘R", onClick: (_e, cx) => v.openRecap(cx) })));
}

/** Whether the board shows the Mac's agents from an earlier read because the last one failed (not: none saved yet). */
const staleSnapshot = (v) => Boolean(v.snapshot && v.snapshotProblem && !(v.snapshotProblem.kind === "missing" && !v.snapshotReadAt));

/** Why the Mac's saved agents could not be read: none saved yet (an empty board until they are), or a read that
 *  failed (the board keeps the agents read before, if any, until a read works again). */
export function snapshotNote(v, now) {
  const p = v.snapshotProblem;
  if (p.kind === "missing" && !v.snapshotReadAt) return Banner({ id: "home-snap-note", tone: "info", title: t("home.snapshot.missing"), body: t("home.snapshot.missingBody") });
  const error = p.kind === "damaged" ? t("home.snapshot.damaged") : p.kind === "missing" ? t("home.snapshot.gone") : p.error;
  const body = v.snapshotReadAt ? t("home.snapshot.keptBody", { error, time: ago(v.snapshotReadAt, now) }) : t("home.snapshot.noneBody", { error });
  return Banner({ id: "home-snap-note", tone: "warning", title: t("home.snapshot.unreadable"), body });
}

// ---------------------------------------------------------------------------------------------------------------------
// The next action.

export function nextBar(v, a, now) {
  const k = tokens();
  const bar = (children) =>
    v_flex()
      .id("home-next")
      .flex_none()
      .rounded(k.radius.md + 2)
      .border_1()
      .border_color(k.line.soft)
      .bg(k.bg.surface)
      .children(children);
  if (!a) {
    return bar([
      h_flex()
        .h(46)
        .px(14)
        .gap(10)
        .items_center()
        .child(Icon("circle-check", { size: 14, color: k.state.done }))
        .child(Text(t("home.next.none"), { tone: "secondary", truncate: true }).flex_1()),
    ]);
  }
  const tail = tailOf(a.address);
  const q = a.status === "blocked" ? tail?.question : null;
  // The state the drawn choices were read at: a click answers that question only (agents.js `choose` checks).
  const seq = tail?.seq;
  const reason = needsReason(a);
  const waited = typeof a.since === "number" ? span(now - a.since) : "";
  const said = q?.text ? t("home.next.quote", { text: q.text }) : reason ?? taskOf(a);
  const lead = a.status === "blocked" ? t("home.next.waiting", { project: project(a), time: waited }) : t("home.next.needs", { project: project(a) });
  const top = h_flex()
    .h(46)
    .pl(14)
    .pr(8)
    .gap(12)
    .items_center()
    .child(h_flex().flex_none().gap(6).items_center().text_color(k.state.blocked).child(Icon("hand", { size: 14 })).child(Text(t("home.next.label"), { size: "xs", weight: "semibold", tone: "blocked", nowrap: true })))
    .child(h_flex().flex_none().gap(6).items_center().child(Mark(a)).child(Text(toolName(a), { weight: "medium", nowrap: true })))
    .child(
      h_flex()
        .flex_1()
        .min_w(0)
        .gap(4)
        .items_center()
        .child(Text(`${lead} ·`, { tone: "secondary", nowrap: true }).flex_none())
        .child(Text(said, { tone: q?.text ? "secondary" : "primary", truncate: true }).flex_1())
        .tooltip(q?.text ?? said),
    )
    .when(tail?.loading && !q, (e) => e.child(Spinner({ size: 12, color: k.text.tertiary, label: t("common.loading") })))
    .when(a.status === "blocked" && !v.replying, (e) => e.child(Button("home-next-write", t("home.next.write"), { variant: "ghost", icon: "reply", kbd: "T", onClick: (_e, cx) => v.startReply(cx), disabled: !v.live })))
    .child(Button("home-next-later", t("home.next.later"), { variant: "ghost", kbd: "L", tooltip: t("home.next.laterHint"), onClick: (_e, cx) => v.later(cx, a), disabled: !v.live }))
    .child(Button("home-next-go", t("home.next.go"), { variant: "primary", kbd: "⌘J", disabled: !v.live, onClick: (_e, cx) => v.go(cx, a) }));
  const choices = q?.choices ?? [];
  const below = [];
  const composing = v.replying === a.address;
  if (choices.length || composing) {
    below.push(
      h_flex()
        .flex_wrap()
        .gap(6)
        .px(14)
        .pb(10)
        .items_center()
        .children(
          choices.map((c) =>
            Button(`home-next-c${c.n}`, c.label, { size: "sm", kbd: String(c.n), tooltip: t("home.next.choose", { label: c.label }), onClick: (_e, cx) => v.choose(cx, a, c.n, seq), disabled: !v.live }),
          ),
        )
        .when(composing && a.status !== "blocked", (e) =>
          e.child(Text(t("home.next.notWaiting", { tool: toolName(a), project: project(a) }), { size: "sm", tone: "warning" }).w_full().role("alert")),
        )
        .when(composing, (e) =>
          e.child(
            h_flex()
              .flex_1()
              .min_w(240)
              .gap(6)
              .items_center()
              .child(inField(v, TextInput(v.replyInput, { id: "home-reply", focused: v.replyFocus.focused, a11y: t("home.next.replyLabel") })))
              .child(Button("home-reply-send", t("home.next.send"), { variant: "primary", size: "sm", icon: "send", kbd: "⏎", disabled: v.sending, onClick: (_e, cx) => v.sendReply(cx) }))
              .child(Button("home-reply-cancel", t("common.cancel"), { variant: "ghost", size: "sm", kbd: "esc", onClick: (_e, cx) => v.cancelReply(cx) })),
          ),
        ),
    );
  }
  return bar([top, ...below]);
}

// ---------------------------------------------------------------------------------------------------------------------
// The board.

function card(v, a, now) {
  const stage = a.stage;
  const wait = stage === "needs";
  const tail = wait && a.status === "blocked" ? tailOf(a.address) : null;
  const task = tail?.question?.text || (wait ? needsReason(a) : null) || taskOf(a);
  const chips = chipsOf(a, { id: `home-${a.address}`, open: (url, cx) => v.openUrl(cx, url) });
  return Card({
    id: `home-card-${a.address}`,
    tone: wait ? "wait" : "default",
    gap: 6,
    onClick: (_e, cx) => v.go(cx, a),
    children: [
      h_flex()
        .gap(7)
        .items_center()
        .min_w(0)
        .child(Mark(a))
        .child(Text(toolName(a), { size: "sm", weight: "medium", nowrap: true }))
        .child(Text(project(a), { size: "sm", tone: "secondary", truncate: true }).flex_1())
        .child(Text(elapsed(a, now), { size: "xs", mono: true, tone: wait ? "blocked" : "tertiary", nowrap: true })),
      Text(task).whitespace_normal(),
      ...(chips.length ? [h_flex().flex_wrap().gap(4).children(chips)] : []),
    ],
  })
    .tooltip(t("home.card.hint"))
    .accessibility_label(t("home.card.label", { tool: toolName(a), project: project(a), task, stage: t(`home.stage.${stage}`) }))
    .on_mouse_down("right", (_e, cx) => v.beside(cx, a));
}

function column(v, stage, rows, now) {
  const k = tokens();
  const meta = STAGE_META[stage];
  const shown = rows.slice(0, PER_COLUMN);
  const more = rows.length - shown.length;
  return v_flex()
    .id(`home-col-${stage}`)
    .flex_1()
    .min_w(0)
    .gap(6)
    .role("list")
    .accessibility_label(t(`home.stage.${stage}`))
    .child(
      SectionHeader({
        variant: "column",
        icon: meta.icon,
        iconColor: stage === "done" ? k.text.secondary : k.state[meta.tone],
        title: t(`home.stage.${stage}`),
        count: rows.length,
        shortcut: meta.kbd ?? undefined,
      }),
    )
    .children(shown.map((a) => card(v, a, now)))
    .when(rows.length === 0, (e) => e.child(EmptySlot(t(`home.stage.${stage}.empty`))))
    .when(more > 0, (e) =>
      e.child(Button(`home-col-${stage}-more`, t("home.stage.more", { n: more }), { variant: "ghost", size: "sm", onClick: (_e, cx) => v.openRecap(cx, stage) })),
    );
}

export function board(v, rows, now) {
  return h_flex()
    .id("home-board-cols")
    .flex_none()
    .w_full()
    .gap(12)
    .items_start()
    .children(STAGE_ORDER.map((stage) => column(v, stage, inStage(rows, stage), now)));
}

/** The keys Home answers to, as a hint line. */
export function keyHints() {
  const k = tokens();
  const hint = (keys, label) => h_flex().gap(4).items_center().child(Kbd(keys)).child(Text(label, { size: "xs", tone: "tertiary", nowrap: true }));
  return h_flex()
    .flex_none()
    .flex_wrap()
    .gap(14)
    .pt(4)
    .border_t(1)
    .border_color(k.line.soft)
    .child(hint("⌘J", t("home.next.go")))
    .child(hint("T", t("home.next.write")))
    .child(hint("1–9", t("home.keys.choose")))
    .child(hint("L", t("home.next.later")))
    .child(hint("⌘R", t("home.recap")))
    .child(div());
}
