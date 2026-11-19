// Recap's pieces: an agent's card (its stage, task, place, recap, facts; for the selected one its screen, question,
// answer and actions) and the Time tab (the week's agent time per ticket from the ledger, fleet.time()).

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { t } from "../../core/i18n.js";
import * as fleet from "../../sys/fleet.js";
import { tokens, withAlpha } from "../../ui/tokens.js";
import { Text, Icon, Button, Chip, TextInput, Spinner, Empty, Kbd } from "../../ui/kit.js";
import { LogBlock, inField } from "./ui.js";
import { StageGlyph, stageColor, Mark, toolName, project, taskOf, elapsed, chipsOf, needsReason, tailOf, recapOf, aiReadOnly, forkSpec, SNOOZES } from "./agents.js";
import { secs, money, ago, weekdayOf } from "./fmt.js";

/** A recap button's state: off when the view cannot act or the agent command cannot run read-only (with why). */
const recapButton = (v) => (aiReadOnly() ? { disabled: !v.live } : { disabled: true, tooltip: t("routines.run-error.read-only-unsupported") });

const list = (v) => (Array.isArray(v) ? v : []);

function recapLine(v, row) {
  const r = recapOf(row);
  if (r?.running) return h_flex().gap(6).items_center().child(Spinner({ size: 12, label: t("home.recap.running") })).child(Text(t("home.recap.running"), { size: "sm", tone: "secondary" }));
  if (r?.text) {
    return v_flex()
      .gap(2)
      .child(Text(r.text, { tone: r.fresh ? "primary" : "secondary" }).whitespace_normal())
      .child(Text([r.fresh ? t("home.recap.fresh", { time: ago(r.at) }) : t("home.recap.stale", { time: ago(r.at) }), typeof r.usd === "number" ? money(r.usd) : ""].filter(Boolean).join(" · "), { size: "xs", tone: "tertiary" }));
  }
  if (r?.error) return Text(r.error === "read-only-unsupported" ? t("routines.run-error.read-only-unsupported") : t("home.recap.failed", { error: r.error }), { size: "sm", tone: "error" }).whitespace_normal();
  return h_flex()
    .gap(8)
    .items_center()
    .child(Text(row.stage === "working" ? t("home.recap.noneWorking") : t("home.recap.none"), { size: "sm", tone: "tertiary" }))
    .child(Button(`rc-${row.address}-make`, t("home.recap.make"), { variant: "ghost", size: "sm", icon: "sparkles", kbd: "R", ...recapButton(v), onClick: (_e, cx) => v.recap(cx, row) }));
}

function questionBlock(v, row) {
  const k = tokens();
  const tail = tailOf(row.address);
  const q = tail?.question;
  // The state the drawn choices were read at: a click answers that question only (agents.js `choose` checks).
  const seq = tail?.seq;
  const replying = v.replying === row.address;
  const tone = k.state.blocked;
  return v_flex()
    .id(`rc-${row.address}-q`)
    .gap(8)
    .p(12)
    .rounded(k.radius.lg)
    .border_1()
    .border_color(withAlpha(tone, 0.45))
    .bg(withAlpha(tone, 0.07))
    .child(
      h_flex()
        .gap(6)
        .items_start()
        .child(Icon("circle-help", { size: 14, color: tone }))
        .child(Text(q?.text || t("home.recap.waiting"), { weight: "medium" }).flex_1().min_w(0).whitespace_normal())
        .when(Boolean(tail?.loading), (e) => e.child(Spinner({ size: 12, color: k.text.tertiary }))),
    )
    .when(list(tail?.lines).length > 0, (e) => e.child(LogBlock(`rc-${row.address}-screen`, tail.lines.slice(-14), { maxHeight: 200 })))
    .when(Boolean(tail?.error), (e) => e.child(Text(t("home.recap.readFailed", { error: tail.error }), { size: "xs", tone: "error" })))
    .when(list(q?.choices).length > 0, (e) =>
      e.child(
        h_flex()
          .flex_wrap()
          .gap(6)
          .children(q.choices.map((c) => Button(`rc-${row.address}-c${c.n}`, c.label, { size: "sm", kbd: String(c.n), disabled: !v.live, onClick: (_e, cx) => v.choose(cx, row, c.n, seq) }))),
      ),
    )
    .child(
      replying
        ? h_flex()
            .gap(6)
            .items_center()
            .child(inField(v, TextInput(v.replyInput, { id: "rc-reply", focused: v.replyFocus.focused, a11y: t("home.next.replyLabel") })))
            .child(Button("rc-reply-send", t("home.next.send"), { variant: "primary", size: "sm", icon: "send", kbd: "⏎", onClick: (_e, cx) => v.sendReply(cx) }))
            .child(Button("rc-reply-cancel", t("common.cancel"), { variant: "ghost", size: "sm", kbd: "esc", onClick: (_e, cx) => v.cancelReply(cx) }))
        : h_flex().child(Button(`rc-${row.address}-reply`, t("home.next.write"), { size: "sm", icon: "reply", kbd: "⇥", disabled: !v.live, onClick: (_e, cx) => v.startReply(cx, row) })),
    );
}

function actions(v, row) {
  const canFork = Boolean(forkSpec(row));
  const snoozing = v.snoozing === row.address;
  const bar = h_flex()
    .flex_wrap()
    .gap(6)
    .items_center()
    .child(Button(`rc-${row.address}-go`, t("home.recap.go"), { variant: "primary", size: "sm", icon: "corner-down-left", kbd: "⏎", onClick: (_e, cx) => v.go(cx, row) }))
    .when(Boolean(recapOf(row)?.text), (e) => e.child(Button(`rc-${row.address}-again`, t("home.recap.again"), { variant: "ghost", size: "sm", icon: "sparkles", kbd: "R", ...recapButton(v), onClick: (_e, cx) => v.recap(cx, row) })))
    .child(
      row.snoozedUntil
        ? Button(`rc-${row.address}-wake`, t("home.recap.wake"), { variant: "ghost", size: "sm", icon: "alarm-clock", kbd: "S", disabled: !v.live, onClick: (_e, cx) => v.wake(cx, row) })
        : Button(`rc-${row.address}-snooze`, t("home.recap.snooze"), { variant: snoozing ? "secondary" : "ghost", size: "sm", icon: "alarm-clock", kbd: "S", disabled: !v.live, onClick: (_e, cx) => v.toggleSnooze(cx, row) }),
    )
    .child(Button(`rc-${row.address}-fork`, t("home.recap.fork"), { variant: "ghost", size: "sm", icon: "git-fork", kbd: "F", disabled: !v.live || !canFork, tooltip: canFork ? t("home.recap.forkHint") : t("home.recap.forkNone"), onClick: (_e, cx) => v.fork(cx, row) }))
    .child(Button(`rc-${row.address}-queue`, t("home.recap.queue"), { variant: "ghost", size: "sm", icon: "list-ordered", kbd: "Q", disabled: !v.live, onClick: (_e, cx) => v.queue(cx, row) }));
  if (!snoozing) return bar;
  return v_flex()
    .gap(6)
    .child(bar)
    .child(
      h_flex()
        .gap(6)
        .items_center()
        .child(Text(t("home.recap.snoozeUntil"), { size: "sm", tone: "secondary" }))
        .children(SNOOZES.map((kind, i) => Button(`rc-${row.address}-sz-${kind}`, t(`home.snooze.${kind}`), { size: "sm", kbd: String(i + 1), onClick: (_e, cx) => v.snooze(cx, row, kind) }))),
    );
}

/** An agent's card. Selected: its screen and question (when it waits), its actions. `time`: `fleet.time(now)`, read
 *  once per Recap render by the caller. */
export function recapCard(v, row, now, time) {
  const k = tokens();
  const on = row.address === v.sel;
  const tone = stageColor(row.stage, k);
  const ticket = row.ticket;
  const spent = ticket ? time?.tickets?.[ticket.key] : null;
  const chips = chipsOf(row, { id: `rc-${row.address}`, open: (url, cx) => v.openUrl(cx, url) });
  if (ticket) chips.push(Chip(ticket.key, { id: `rc-${row.address}-ticket`, icon: "ticket", tooltip: ticket.url ?? t("inbox.ticket-no-link", { key: ticket.key }), onClick: ticket.url ? (_e, cx) => v.openUrl(cx, ticket.url) : undefined }));
  if (spent?.today) chips.push(Chip(t("home.recap.timeToday", { time: secs(spent.today) }), { icon: "timer", tooltip: t("home.recap.timeTip", { today: secs(spent.today), week: secs(spent.week) }) }));
  const reason = row.stage === "needs" ? needsReason(row) : null;
  return h_flex()
    .id(`rc-card-${row.address}`)
    .w_full()
    .flex_none()
    .rounded(k.radius.lg)
    .border_1()
    .border_color(on ? withAlpha(tone, 0.6) : k.line.soft)
    .bg(on ? withAlpha(tone, 0.06) : k.bg.card)
    .overflow_hidden()
    .cursor_pointer()
    .role("list_item")
    .aria_selected(on)
    .accessibility_label(t("home.card.label", { tool: toolName(row), project: project(row), task: taskOf(row), stage: t(`home.stage.${row.stage}`) }))
    .on_click((_e, cx) => v.pick(cx, row))
    .child(div().w(3).h_full().flex_none().bg(on ? tone : withAlpha(tone, 0)))
    .child(
      v_flex()
        .flex_1()
        .min_w(0)
        .px(14)
        .py(11)
        .gap(8)
        .child(
          h_flex()
            .gap(10)
            .items_center()
            .min_w(0)
            .child(StageGlyph(row.stage, { size: 14 }))
            .child(Text(taskOf(row), { size: "lg", weight: "semibold", truncate: true }).flex_shrink_1())
            .child(h_flex().flex_none().gap(5).items_center().child(Mark(row, { size: 13 })).child(Text(toolName(row), { size: "sm", tone: "secondary", nowrap: true })))
            .child(Chip(`${row.space_name ?? ""} · ${row.tab_name ?? ""}`, { icon: "terminal", mono: true }))
            .child(div().flex_1())
            .child(Text(elapsed(row, now), { size: "sm", weight: "medium", color: tone, nowrap: true })),
        )
        .when(Boolean(reason), (e) => e.child(Text(reason, { size: "sm", tone: "blocked" })))
        .when(on && row.status === "blocked", (e) => e.child(questionBlock(v, row)))
        .child(recapLine(v, row))
        .when(chips.length > 0, (e) => e.child(h_flex().flex_wrap().gap(6).children(chips)))
        .when(on, (e) => e.child(actions(v, row))),
    );
}

// ---------------------------------------------------------------------------------------------------------------------
// The Time tab.

export function timeTable(rows, now) {
  const k = tokens();
  const time = fleet.time(now);
  const keys = Object.keys(time.week ?? {});
  if (!keys.length) return Empty({ id: "rc-time-empty", icon: "timer", title: t("home.recap.timeEmpty"), body: t("home.recap.timeEmptyBody") });
  const days = list(time.days);
  const d = new Date(now);
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const sorted = keys.sort((a, b) => (time.tickets[b]?.week ?? 0) - (time.tickets[a]?.week ?? 0));
  const max = Math.max(1, ...sorted.flatMap((key) => time.week[key]));
  const prOf = (key) => rows.find((r) => r.ticket?.key === key && r.pr)?.pr ?? null;
  const cell = (s, isToday) =>
    v_flex()
      .flex_1()
      .min_w(0)
      .gap(3)
      .child(Text(s ? secs(s) : "·", { size: "xs", mono: true, tone: s ? (isToday ? "primary" : "secondary") : "tertiary", nowrap: true }))
      .child(div().h(3).rounded(2).bg(k.bg.hover).child(div().h_full().rounded(2).bg(isToday ? k.accent : withAlpha(k.accent, 0.45)).w(`${Math.round((s / max) * 100)}%`)));
  const head = h_flex()
    .h(k.row.sm)
    .gap(10)
    .items_center()
    .border_b(1)
    .border_color(k.line.soft)
    .child(Text(t("home.recap.ticket"), { size: "xs", tone: "tertiary" }).w(220).flex_none())
    .children(days.map((day) => Text(day === today ? t("home.recap.todayCol", { day: weekdayOf(day) }) : weekdayOf(day), { size: "xs", tone: day === today ? "primary" : "tertiary", weight: day === today ? "semibold" : undefined, nowrap: true }).flex_1().min_w(0)))
    .child(Text(t("home.recap.weekCol"), { size: "xs", tone: "tertiary" }).w(72).flex_none().text_right());
  const body = sorted.map((key) => {
    const pr = prOf(key);
    return h_flex()
      .id(`rc-time-${key}`)
      .min_h(36)
      .gap(10)
      .items_center()
      .border_b(1)
      .border_color(k.line.soft)
      .child(
        h_flex()
          .w(220)
          .flex_none()
          .gap(6)
          .items_center()
          .min_w(0)
          .child(Icon("ticket", { size: 13, color: k.accent }))
          .child(Text(key, { size: "sm", weight: "semibold", nowrap: true }))
          .when(Boolean(pr), (e) => e.child(Text(`#${pr.number}`, { size: "xs", mono: true, tone: "tertiary" })).tooltip(pr.title)),
      )
      .children(days.map((day, i) => cell(time.week[key][i] ?? 0, day === today)))
      .child(Text(secs(time.tickets[key]?.week ?? 0), { size: "sm", mono: true, weight: "semibold", nowrap: true }).w(72).flex_none().text_right());
  });
  const total = sorted.reduce((s, key) => s + (time.tickets[key]?.week ?? 0), 0);
  return v_flex()
    .gap(10)
    .child(Text(t("home.recap.timeSummary", { time: secs(total), n: sorted.length }), { size: "sm", tone: "secondary" }))
    .child(v_flex().child(head).children(body));
}

/** The dialog's key hints. */
export function hints() {
  const k = tokens();
  const hint = (keys, label) => h_flex().gap(4).items_center().child(Kbd(keys)).child(Text(label, { size: "xs", tone: "tertiary", nowrap: true }));
  return h_flex()
    .flex_none()
    .flex_wrap()
    .gap(14)
    .px(20)
    .py(8)
    .border_t(1)
    .border_color(k.line.soft)
    .child(hint("↑↓", t("home.recap.keyMove")))
    .child(hint("⏎", t("home.recap.go")))
    .child(hint("⇥", t("home.next.write")))
    .child(hint("1–9", t("home.keys.choose")))
    .child(hint("R", t("home.recap.make")))
    .child(hint("S", t("home.recap.snooze")))
    .child(hint("F", t("home.recap.fork")))
    .child(hint("←→", t("home.recap.keyTab")))
    .child(hint("/", t("home.recap.keyFilter")))
    .child(hint("esc", t("common.close")));
}
