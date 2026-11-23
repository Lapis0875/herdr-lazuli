// The transcript's pieces (K5 items, D18, A5, A6): the user's message, Hermes's markdown text with a caret while it
// streams, a thought (collapsed to one line), a tool card (collapsed: kind, title, status, duration; open: input,
// changes as a diff, output), an approval card (Allow once / Always allow / Deny as buttons, the rest in More, a 60 s
// countdown, expired and answered states), a notice line, and the plan dock above the composer.
// Expanded items and the open More menu are the chat view's own state (`view.expanded`, `view.more`).

import { div } from "gpui-kit";
import { h_flex, v_flex, Popover } from "gpui-base";
import { t } from "../../core/i18n.js";
import { tokens, withAlpha } from "../../ui/tokens.js";
import { Text, Icon, Button, Spinner, Badge, Spacer, Menu, MenuItem } from "../../ui/kit.js";
import { Markdown } from "../panels/tree-parts.js";
import { lineDiff } from "./diff.js";
import { approvalButtons } from "../../core/assistant-chat.js";
import { permissionState, secondsLeft, toolWaits, planProgress } from "./model.js";

const OUTPUT_LINES = 12;
// At most this many diff lines in a card, and this many characters of any one code or diff line (the lines do not
// wrap; a 1 MiB one-line edit must not reach the text layout whole, AT-22).
const DIFF_LINES = 200;
const LINE_CHARS = 400;
const clip = (s) => (s === "" ? " " : s.length > LINE_CHARS ? `${s.slice(0, LINE_CHARS)}…` : s);
const KIND_ICON = { read: "file-text", edit: "file-diff", delete: "trash-2", move: "move-horizontal", search: "search", execute: "terminal", think: "brain", fetch: "globe", switch_mode: "layers", other: "wrench" };
const OPTION_LABELS = ["allow_once", "allow_always", "allow_session", "deny", "deny_always"];
const list = (v) => (Array.isArray(v) ? v : []);

/** An option's label: lazuli's words for Hermes's known ids (D29), else the name Hermes sent. */
export const optionLabel = (o) => (OPTION_LABELS.includes(o?.optionId) ? t(`assistant.option.${o.optionId}`) : (o?.name ?? o?.optionId ?? ""));

/** A small caption above a section of a card: "Input", "Output", "Changes". */
const Caption = (text) => Text(text, { size: "xs", tone: "tertiary", weight: "medium" });

/** Code-font lines on the surface fill, at most `max` with "N more lines" after. */
function CodeBlock(id, text, max = OUTPUT_LINES) {
  const k = tokens();
  const lines = String(text ?? "").replace(/\n+$/, "").split("\n");
  const shown = lines.slice(0, max);
  return v_flex()
    .id(id)
    .w_full()
    .min_w(0)
    .px(8)
    .py(6)
    .rounded(k.radius.sm)
    .bg(k.bg.surface)
    .border_1()
    .border_color(k.line.soft)
    .overflow_hidden()
    .children(shown.map((l) => Text(clip(l), { size: "sm", mono: true, nowrap: true })))
    .when(lines.length > max, (e) => e.child(Text(t("assistant.tool.more", { count: lines.length - max }), { size: "xs", tone: "tertiary" }).mt(2)));
}

// A content object's diff, computed once: the 1 MiB edit of AT-22 is cut at DIFF_LINES and diffed only when shown.
const diffs = new WeakMap();
function diffOf(c) {
  if (!diffs.has(c)) diffs.set(c, lineDiff(c.oldText, c.newText, { maxLines: DIFF_LINES }));
  return diffs.get(c);
}

/** A diff content block: file header with +/− counts, then unified lines with their sign column. */
export function DiffBlock(id, c) {
  const k = tokens();
  const d = diffOf(c);
  const head = h_flex()
    .h(26)
    .flex_none()
    .px(8)
    .gap(6)
    .items_center()
    .bg(k.bg.surface)
    .border_b_1()
    .border_color(k.line.soft)
    .child(Icon("file-diff", { size: 12, color: k.text.secondary }))
    .child(Text(c.path ?? "", { size: "xs", mono: true, truncate: true }).flex_1())
    .when(d.add > 0, (e) => e.child(Text(`+${d.add}`, { size: "xs", mono: true, color: k.diff.add })))
    .when(d.remove > 0, (e) => e.child(Text(`−${d.remove}`, { size: "xs", mono: true, color: k.diff.remove })));
  const line = ([sign, text], i) => {
    const add = sign === "+";
    const rem = sign === "-";
    const hunk = sign === "@";
    return h_flex()
      .id(`${id}-l${i}`)
      .flex_none()
      .min_w(0)
      .pr(8)
      .when(add, (e) => e.bg(k.diff.addBg))
      .when(rem, (e) => e.bg(k.diff.removeBg))
      .when(hunk, (e) => e.bg(k.bg.surface))
      .child(Text(hunk ? "" : add ? "+" : rem ? "−" : "", { size: "sm", mono: true, color: add ? k.diff.add : rem ? k.diff.remove : k.text.tertiary }).w(22).flex_none().text_center())
      .child(Text(clip(text), { size: "sm", mono: true, nowrap: true, tone: hunk ? "tertiary" : "primary" }).flex_1().min_w(0).overflow_hidden());
  };
  return v_flex()
    .id(id)
    .w_full()
    .min_w(0)
    .rounded(k.radius.sm)
    .border_1()
    .border_color(k.line.soft)
    .overflow_hidden()
    .child(head)
    .children(d.lines.map(line))
    .when(d.more > 0, (e) => e.child(Text(t("assistant.tool.more", { count: d.more }), { size: "xs", tone: "tertiary" }).px(8).py(4)));
}

/** A toggle header's chevron. */
const Chevron = (open) => Icon(open ? "chevron-down" : "chevron-right", { size: 12, color: tokens().text.tertiary });

// --------------------------------------------------------------------------------------------------------------------
// Messages.

/** The user's message: a surface box; a steer or a queued send says so above the text; attached files as chips. */
export function UserItem(id, it) {
  const k = tokens();
  const tag = it.via === "steer" ? ["navigation", t(it.sending ? "assistant.user.steerSending" : "assistant.user.steer")] : it.via === "queue" ? ["list-ordered", t("assistant.user.queued")] : null;
  const atts = list(it.attachments).map((a) => (typeof a === "string" ? a : (a?.path ?? a?.name ?? a?.uri ?? ""))).filter(Boolean);
  return v_flex()
    .id(id)
    .flex_none()
    .w_full()
    .px(12)
    .py(8)
    .gap(6)
    .rounded(k.radius.lg)
    .bg(k.bg.surface)
    .border_1()
    .border_color(k.line.soft)
    .when(Boolean(tag), (e) =>
      e.child(
        h_flex()
          .gap(5)
          .items_center()
          .text_color(k.text.secondary)
          .child(it.sending ? Spinner({ size: 12 }) : Icon(tag[0], { size: 12 }))
          .child(Text(tag[1], { size: "xs", tone: "secondary", weight: "medium" })),
      ),
    )
    .child(Text(it.text ?? ""))
    .when(atts.length > 0, (e) =>
      e.child(
        h_flex()
          .gap(4)
          .flex_wrap()
          .children(atts.map((a) => h_flex().h(k.control.chip).px(6).gap(4).items_center().rounded(k.radius.sm).border_1().border_color(k.line.soft).bg(k.bg.raised).child(Icon("paperclip", { size: 12, color: k.text.tertiary })).child(Text(a.replace(/^file:\/\//, ""), { size: "xs", mono: true, nowrap: true })))),
      ),
    );
}

/** Hermes's text through lazuli's markdown view; a breathing accent caret under it while it streams. */
export function AgentText(id, it) {
  const k = tokens();
  return v_flex()
    .flex_none()
    .w_full()
    .min_w(0)
    .gap(4)
    .px(2)
    .child(Markdown(id, it.text ?? "", { size: "md" }))
    .when(Boolean(it.streaming), (e) => e.child(div().w(7).h(15).rounded(1).bg(k.accent).loop("opacity", { from: 0.35, to: 1, period: 700 })));
}

/** A thought: one line ("Thinking" and its first line) that opens to the whole text beside a rule. */
export function ThoughtItem(view, id, it) {
  const k = tokens();
  const open = view.expanded.has(id);
  const text = String(it.text ?? "");
  const first = text.split("\n").find((l) => l.trim()) ?? "";
  const head = h_flex()
    .id(id)
    .h(k.row.md)
    .px(8)
    .mx(-6)
    .gap(8)
    .items_center()
    .rounded(k.radius.md)
    .cursor_pointer()
    .text_color(k.text.secondary)
    .hover((s) => s.bg(k.bg.hover))
    .role("button")
    .tab_index(0)
    .accessibility_label(`${t(it.streaming ? "assistant.thought.streaming" : "assistant.thought")} · ${t(open ? "assistant.item.hide" : "assistant.item.show")}`)
    .on_click((_e, cx) => view.toggle(cx, id))
    .child(it.streaming ? Icon("brain", { size: 14 }).loop("opacity", { from: 0.45, to: 1, period: 1400 }) : Icon("brain", { size: 14 }))
    .child(Text(t(it.streaming ? "assistant.thought.streaming" : "assistant.thought"), { size: "sm", weight: "medium", tone: "secondary", nowrap: true }))
    .child(Text(open ? "" : first, { size: "sm", tone: "tertiary", truncate: true }).flex_1())
    .child(Chevron(open));
  return v_flex()
    .flex_none()
    .w_full()
    .child(head)
    .when(open, (e) =>
      e.child(
        v_flex()
          .mt(2)
          .ml(7)
          .pl(14)
          .py(2)
          .gap(6)
          .border_l(2)
          .border_color(k.line.soft)
          .children(text.split(/\n{2,}/).map((p) => Text(p, { size: "sm", tone: "secondary" }))),
      ),
    );
}

const STATUS = {
  completed: ["circle-check", "success", "assistant.tool.completed"],
  failed: ["circle-x", "error", "assistant.tool.failed"],
  in_progress: [null, "working", "assistant.tool.in_progress"],
  pending: ["circle-dashed", "tertiary", "assistant.tool.pending"],
  waiting: ["hand", "blocked", "assistant.tool.waiting"],
};

/** A tool call (a K5 `rows` tool row: `duration` set once it ended live): collapsed to its header, open to its input,
 *  its changes (its own diff content, and an edit approval's diff, K5 rule 3) and its output (A5, AT-09). */
export function ToolCard(view, chat, id, it, now) {
  const k = tokens();
  const open = view.expanded.has(id);
  const waits = toolWaits(chat, it, now);
  const [icon, tone, label] = STATUS[waits ? "waiting" : it.status] ?? STATUS.pending;
  const ms = typeof it.duration === "number" ? it.duration : null;
  const status = h_flex()
    .flex_none()
    .gap(5)
    .items_center()
    .child(icon ? Icon(icon, { size: 13, color: tone === "tertiary" ? k.text.tertiary : k.state[tone] }) : Spinner({ size: 13 }))
    .child(Text(t(label), { size: "xs", tone, nowrap: true }));
  const head = h_flex()
    .id(id)
    .h(32)
    .pl(10)
    .pr(6)
    .gap(8)
    .items_center()
    .cursor_pointer()
    .rounded(k.radius.md)
    .hover((s) => s.bg(k.bg.hover))
    .role("button")
    .tab_index(0)
    .accessibility_label(`${it.title ?? ""} · ${t(label)} · ${t(open ? "assistant.item.hide" : "assistant.item.show")}`)
    .on_click((_e, cx) => view.toggle(cx, id))
    .child(Icon(KIND_ICON[it.kind] ?? "wrench", { size: 14, color: k.text.secondary }))
    .child(Text(it.title ?? "", { size: "sm", truncate: true, mono: it.kind === "execute" }).flex_1())
    .child(status)
    .when(ms !== null, (e) => e.child(Text(t("assistant.tool.seconds", { n: (ms / 1000).toFixed(1) }), { size: "xs", tone: "tertiary", mono: true, nowrap: true })))
    .child(div().size(20).flex_none().flex().items_center().justify_center().child(Chevron(open)));
  const card = v_flex()
    .flex_none()
    .w_full()
    .min_w(0)
    .rounded(k.radius.md)
    .border_1()
    .border_color(waits ? withAlpha(k.state.blocked, 0.45) : k.line.soft)
    .bg(k.bg.card)
    .child(head);
  if (!open) return card;
  const parts = [];
  if (it.input !== undefined && it.input !== null) {
    parts.push(Caption(t("assistant.tool.input")), CodeBlock(`${id}-in`, typeof it.input === "string" ? it.input : JSON.stringify(it.input, null, 2)));
  }
  const content = list(it.content);
  const diffs = content.filter((c) => c?.type === "diff");
  if (it.diff && !diffs.some((c) => c.path === it.diff.path && c.newText === it.diff.newText)) diffs.push(it.diff);
  diffs.forEach((c, i) => parts.push(Caption(t("assistant.tool.changes")), DiffBlock(`${id}-d${i}`, c)));
  const texts = content.filter((c) => c?.type === "text" && typeof c.text === "string" && c.text !== "").map((c) => c.text);
  const raw = it.rawOutput === undefined || it.rawOutput === null ? "" : typeof it.rawOutput === "string" ? it.rawOutput : JSON.stringify(it.rawOutput, null, 2);
  // The output is the content's text; Hermes sends a raw result besides it only for tools it did not word.
  const output = texts.length ? texts.join("\n") : raw;
  // The start content stands as the Input until an update replaces it; then it is not output too.
  if (output && output !== it.input) parts.push(Caption(t("assistant.tool.output")), CodeBlock(`${id}-out`, output));
  else if (!output && !diffs.length && it.status === "completed") parts.push(Text(t("assistant.tool.empty"), { size: "sm", tone: "tertiary" }));
  return card.child(v_flex().px(10).pt(8).pb(10).gap(6).border_t_1().border_color(k.line.soft).children(parts));
}

// --------------------------------------------------------------------------------------------------------------------
// Approvals.

/** An approval request (a K5 `rows` permission row, D29): its `buttons` (Hermes: allow_once, allow_always, deny when
 *  offered) and the rest in More; a countdown from the deadline with a draining bar. Expired and cancelled requests
 *  keep their card, buttons off; an answered one folds to one line. */
export function ApprovalCard(view, chat, p, now) {
  const k = tokens();
  const id = String(p.requestId);
  const state = permissionState(p, now);
  const edit = p.edit ?? String(p.toolCallId ?? "").startsWith("edit-approval-");
  const title = t(edit ? "assistant.approval.editTitle" : "assistant.approval.title");
  const options = list(p.options);
  const split = p.buttons && p.more ? { buttons: p.buttons, more: p.more } : approvalButtons(options, chat.agent);
  const cardId = `ac-perm-${id}`;
  if (state === "answered") {
    const chosen = options.find((o) => o.optionId === p.optionId);
    const denied = String(p.optionId ?? "").startsWith("deny");
    return h_flex()
      .id(cardId)
      .flex_none()
      .h(26)
      .px(2)
      .gap(7)
      .items_center()
      .child(Icon(denied ? "circle-x" : "circle-check", { size: 13, color: denied ? k.text.secondary : k.state.success }))
      .child(Text(title, { size: "sm", tone: "secondary", nowrap: true }))
      .child(Text(t("assistant.approval.answered", { option: chosen ? optionLabel(chosen) : (p.optionId ?? "") }), { size: "sm", tone: "tertiary", truncate: true }));
  }
  const live = state === "pending";
  const left = live ? secondsLeft(p, now) : 0;
  const head = h_flex()
    .h(20)
    .gap(8)
    .items_center()
    .child(live ? Icon("hand", { size: 14, color: k.state.blocked }) : Icon("hourglass", { size: 14, color: k.text.secondary }))
    .child(Text(title, { weight: "semibold", truncate: true, tone: live ? "primary" : "secondary" }).flex_shrink_1())
    .child(Spacer())
    .child(
      live
        ? h_flex().flex_none().gap(5).items_center().accessibility_label(t("assistant.approval.left", { n: left })).child(Icon("timer", { size: 12, color: k.state.blocked })).child(Text(t("assistant.approval.left", { n: left }), { size: "xs", tone: "blocked", mono: true, nowrap: true }))
        : Badge(t(state === "cancelled" ? "assistant.approval.cancelled" : "assistant.approval.expired")),
    );
  const body = [];
  list(p.content).forEach((c, i) => {
    if (c?.type === "diff") body.push(DiffBlock(`${cardId}-d${i}`, c));
    else if (c?.type === "text" && typeof c.text === "string" && c.text) body.push(CodeBlock(`${cardId}-c${i}`, c.text, 8));
  });
  if (!body.length && p.title) body.push(Text(p.title, { size: "sm", tone: "secondary" }));
  if (!live) body.push(Text(t(state === "cancelled" ? "assistant.approval.cancelledBody" : "assistant.approval.expiredBody"), { size: "sm", tone: "secondary" }));
  const answer = (optionId) => (_e, cx) => view.answer(cx, chat.key, id, optionId);
  const buttons = split.buttons
    .filter(Boolean)
    .map((o) =>
      Button(`${cardId}-${o.optionId}`, optionLabel(o), {
        variant: o.optionId === "allow_once" ? "primary" : "secondary",
        size: "sm",
        icon: o.optionId === "deny" ? "x" : o.optionId === "allow_always" ? "shield-check" : "check",
        disabled: !live,
        onClick: answer(o.optionId),
      }),
    );
  const others = split.more;
  const actions = [...buttons];
  if (others.length) {
    const open = live && view.more === id;
    const trigger = Button(`${cardId}-more`, t("assistant.approval.more"), { variant: "ghost", size: "sm", disabled: !live, look: open ? "active" : undefined }).child(Icon("chevron-down", { size: 12 }));
    let more = trigger;
    if (live) {
      more = Popover.new(`${cardId}-more-menu`)
        .trigger(trigger)
        .open(open)
        .on_open_change((value, cx) => {
          view.more = value ? id : null;
          cx.notify();
        });
      if (open) {
        more = more.content(
          Menu({
            id: `${cardId}-menu`,
            width: 220,
            label: t("assistant.approval.moreLabel"),
            children: others.map((o) =>
              MenuItem(`${cardId}-m-${o.optionId}`, {
                label: optionLabel(o),
                icon: String(o.kind ?? "").startsWith("reject") ? "circle-x" : "shield-check",
                danger: String(o.kind ?? "").startsWith("reject"),
                onClick: (_e, cx) => {
                  view.more = null;
                  view.answer(cx, chat.key, id, o.optionId);
                },
              }),
            ),
          }),
        );
      }
    }
    actions.push(Spacer(), more);
  }
  const ratio = live ? Math.max(0, Math.min(1, left / 60)) : 0;
  return v_flex()
    .id(cardId)
    .flex_none()
    .w_full()
    .min_w(0)
    .pl(12)
    .pr(12)
    .pt(10)
    .pb(12)
    .gap(8)
    .rounded(k.radius.lg)
    .bg(live ? k.bg.surface : k.bg.card)
    .border_1()
    .border_color(live ? withAlpha(k.state.blocked, 0.45) : k.line.soft)
    .role("group")
    .accessibility_label(title)
    .child(head)
    .children(body)
    .child(h_flex().gap(6).items_center().children(actions))
    .child(
      div()
        .w_full()
        .h(3)
        .rounded(k.radius.full)
        .bg(live ? withAlpha(k.state.blocked, 0.2) : k.bg.hover)
        .child(div().h_full().rounded(k.radius.full).bg(k.state.blocked).w(`${Math.round(ratio * 1000) / 10}%`)),
    );
}

// --------------------------------------------------------------------------------------------------------------------
// Notices and the plan.

const EVENT_ICON = {
  "steer-ack": ["navigation", "accent"],
  "steer-queued": ["navigation", "secondary"],
  "steer-failed": ["triangle-alert", "warning"],
  cancelled: ["circle-stop", "secondary"],
  stopped: ["circle-stop", "secondary"],
  "too-late": ["hourglass", "blocked"],
  failed: ["circle-x", "error"],
  dropped: ["info", "secondary"],
  "model-set": ["check", "secondary"],
  busy: ["info", "secondary"],
  gap: ["triangle-alert", "warning"],
};

/** A notice line (K5 `notice{code, vars}`): its icon, lazuli's words for the code, a detail (an error) in code font. */
export function NoticeItem(id, it) {
  const k = tokens();
  const known = Object.prototype.hasOwnProperty.call(EVENT_ICON, it.code);
  const [icon, tone] = known ? EVENT_ICON[it.code] : ["info", "secondary"];
  const vars = it.vars ?? {};
  const detail = typeof vars.detail === "string" ? vars.detail : typeof vars.text === "string" ? vars.text : null;
  return h_flex()
    .id(id)
    .flex_none()
    .min_h(20)
    .px(2)
    .gap(7)
    .items_center()
    .role("status")
    .child(Icon(icon, { size: 13, color: tone === "secondary" ? k.text.secondary : tone === "accent" ? k.accent : k.state[tone] }))
    .child(Text(t(known ? `assistant.event.${it.code}` : "assistant.event.other", vars), { size: "sm", tone: "secondary" }).flex_shrink_1())
    .when(Boolean(detail), (e) => e.child(Text(detail, { size: "xs", tone: "tertiary", mono: true, truncate: true }).flex_shrink_1()));
}

/** The session's plan, docked above the composer: one row closed (Plan, n of m, the entry in progress), the entries
 *  open (done, in progress, pending). */
export function PlanDock(view, plan) {
  const k = tokens();
  const { done, total, now } = planProgress(plan);
  const open = view.planOpen;
  const head = h_flex()
    .id("ac-plan")
    .h(30)
    .gap(7)
    .items_center()
    .cursor_pointer()
    .role("button")
    .tab_index(0)
    .accessibility_label(`${t("assistant.plan.title")} · ${t("assistant.plan.progress", { done, total })}`)
    .on_click((_e, cx) => {
      view.planOpen = !view.planOpen;
      cx.notify();
    })
    .child(Icon("list-todo", { size: 14, color: k.text.secondary }))
    .child(Text(t("assistant.plan.title"), { size: "sm", weight: "semibold", nowrap: true }))
    .child(Text(t("assistant.plan.progress", { done, total }), { size: "sm", tone: "tertiary", nowrap: true }))
    .child(Text(open || !now ? "" : String(now.content ?? ""), { size: "sm", truncate: true }).flex_1())
    .child(Icon(open ? "chevron-down" : "chevron-up", { size: 12, color: k.text.tertiary }));
  const ICON = { completed: ["circle-check", k.state.success, "tertiary"], in_progress: ["circle-dot", k.state.working, "primary"], pending: ["circle", k.text.tertiary, "secondary"] };
  const entry = (e, i) => {
    const [icon, color, tone] = ICON[e.status] ?? ICON.pending;
    const glyph = Icon(icon, { size: 14, color });
    return h_flex()
      .id(`ac-plan-${i}`)
      .py(2)
      .gap(8)
      .items_start()
      .child(div().pt(3).flex_none().child(e.status === "in_progress" ? glyph.loop("opacity", { from: 0.45, to: 1, period: 1400 }) : glyph))
      .child(Text(String(e.content ?? ""), { size: "sm", tone, weight: e.status === "in_progress" ? "medium" : undefined }).flex_1());
  };
  return v_flex()
    .flex_none()
    .mx(12)
    .mb(8)
    .px(10)
    .rounded(k.radius.md)
    .bg(k.bg.surface)
    .border_1()
    .border_color(k.line.soft)
    .child(head)
    .when(open, (e) => e.child(v_flex().pb(8).children(list(plan?.entries).map(entry))));
}
