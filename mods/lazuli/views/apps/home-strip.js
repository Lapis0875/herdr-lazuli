// Home's lower half: the apps in a few rows each (Inbox, To-do, Routines), the week's spend, the recent events
// (GitHub, routines, agents) and the terminals whose session restore is pending or failed (DESIGN A7).

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { home as homeDir } from "herdr";
import { t } from "../../core/i18n.js";
import * as gh from "../../sys/gh.js";
import * as todo from "../../sys/todo.js";
import * as routines from "../../sys/routines.js";
import * as store from "../../sys/store.js";
import { STORE } from "../../sys/state.js";
import { tokens, withAlpha } from "../../ui/tokens.js";
import { Text, Icon, Button, IconButton, SectionHeader, CheckBox, StatusDot, Badge, AgentMark, Divider } from "../../ui/kit.js";
import { attention, attentionCount } from "./inbox-model.js";
import { agentEvents } from "./agents.js";
import { clock, money, span, when, tilde, tokensText, weekdayOf, firstLine } from "./fmt.js";

const list = (v) => (Array.isArray(v) ? v : []);
const ROWS = 3;

// A summary row: leading element, text, trailing note; a click opens the app on it.
function line(id, { lead, text, note, onClick, tooltip }) {
  const k = tokens();
  return h_flex()
    .id(id)
    .h(k.row.sm)
    .gap(8)
    .items_center()
    .min_w(0)
    .px(4)
    .mx(-4)
    .rounded(k.radius.sm)
    .when(Boolean(onClick), (e) => e.cursor_pointer().hover((s) => s.bg(k.bg.hover)).on_click(onClick))
    .when(Boolean(tooltip), (e) => e.tooltip(tooltip))
    .when(Boolean(lead), (e) => e.child(lead))
    .child(Text(text ?? "", { size: "sm", truncate: true }).flex_1())
    .when(note !== undefined && note !== null && note !== "", (e) => e.child(Text(note, { size: "xs", mono: true, tone: "tertiary", nowrap: true })));
}

// A strip section's heading: a click opens the app.
function heading(id, { icon, title, count, kbd, onClick }) {
  const k = tokens();
  return SectionHeader({ icon, title, count, shortcut: kbd })
    .id(id)
    .cursor_pointer()
    .rounded(k.radius.sm)
    .hover((s) => s.bg(k.bg.hover))
    .tooltip(t("home.strip.open", { app: title }))
    .on_click(onClick);
}

function section(children, first) {
  const k = tokens();
  return v_flex()
    .flex_1()
    .min_w(0)
    .gap(4)
    .when(!first, (e) => e.pl(16).border_l(1).border_color(k.line.soft))
    .pr(16)
    .children(children);
}

function inboxSection(v) {
  const data = gh.data();
  const rows = attention(data).slice(0, ROWS);
  const open = (key) => (_e, cx) => v.openApp(cx, "inbox", key);
  const body = rows.length
    ? rows.map((r, i) =>
        line(`home-in-${i}`, { lead: Badge(r.tag, { tone: r.tone, variant: "text" }), text: r.title, note: r.ref, onClick: open(r.key), tooltip: r.title }),
      )
    : [Text(data?.error?.kind === "auth" ? t("home.sync.auth") : t("home.strip.inboxEmpty"), { size: "sm", tone: "tertiary" })];
  return [heading("home-h-inbox", { icon: "inbox", title: t("home.app.inbox"), count: attentionCount(data), kbd: "⌥⌘1", onClick: open(undefined) }), ...body];
}

function todoSection(v) {
  const k = tokens();
  const m = todo.get();
  const items = list(m?.items).filter((i) => !i.done).slice(0, ROWS);
  const body = items.length
    ? items.map((it, i) =>
        h_flex()
          .id(`home-td-${i}`)
          .h(k.row.sm)
          .gap(6)
          .items_center()
          .min_w(0)
          .child(CheckBox(`home-td-check-${i}`, false, (_v, cx) => v.toggleTodo(cx, it.key), { disabled: !v.live }).accessibility_label(t("home.strip.todoDone", { text: it.undated })))
          .child(line(`home-td-row-${i}`, { text: it.undated, note: it.links[0]?.label ?? "", onClick: (_e, cx) => v.openApp(cx, "todo", it.key), tooltip: it.undated }).flex_1()),
      )
    : [Text(m?.items?.length ? t("home.strip.todoAllDone") : t("home.strip.todoEmpty"), { size: "sm", tone: "tertiary" })];
  return [heading("home-h-todo", { icon: "list-todo", title: t("home.app.todo"), count: m?.open ?? 0, kbd: "⌥⌘2", onClick: (_e, cx) => v.openApp(cx, "todo") }), ...body];
}

/** A routine as Home lists it: dot, name, and its run, next time or last cost. */
function routineLine(v, r, i, now) {
  const running = r.running && typeof r.running.started === "number";
  const last = r.last;
  const dot = running ? StatusDot("working", { pulse: true, label: t("routines.run.running") }) : last && !last.ok ? StatusDot("blocked", { label: t("routines.run.failed") }) : last ? StatusDot("done", { label: t("routines.run.ok") }) : StatusDot("idle", { label: t("home.strip.never") });
  const note = running
    ? t("home.strip.running", { time: span(now - r.running.started) })
    : r.queued
      ? t("routines.run.queued")
      : typeof r.next === "number"
        ? when(r.next, now)
        : typeof last?.cost === "number"
          ? money(last.cost)
          : "";
  return line(`home-rt-${i}`, { lead: dot, text: r.name, note, onClick: (_e, cx) => v.openApp(cx, "routines", r.slug), tooltip: r.name });
}

function routinesSection(v, now) {
  const all = list(routines.data()?.routines);
  const rank = (r) => (r.running ? 0 : r.queued ? 1 : typeof r.next === "number" ? 2 : 3);
  const shown = [...all].sort((a, b) => rank(a) - rank(b) || (a.next ?? Infinity) - (b.next ?? Infinity)).slice(0, ROWS);
  const body = shown.length ? shown.map((r, i) => routineLine(v, r, i, now)) : [Text(t("home.strip.routinesEmpty"), { size: "sm", tone: "tertiary" })];
  return [heading("home-h-routines", { icon: "calendar-clock", title: t("home.app.routines"), count: all.length, kbd: "⌥⌘3", onClick: (_e, cx) => v.openApp(cx, "routines") }), ...body];
}

const TOOL_LABEL = { omp: "omp", claude: "Claude", codex: "Codex" };

function spendSection(now) {
  const k = tokens();
  const u = store.get(STORE.scan)?.usage;
  const head = SectionHeader({ icon: "chart-column", title: t("home.spend.title") });
  if (!u || (!u.week && u.error)) return [head, Text(u?.error ? t("home.spend.failed") : t("home.spend.loading"), { size: "sm", tone: "tertiary" })];
  const days = list(u.days);
  const d = new Date(now);
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const priced = days.some((x) => x.usd > 0);
  const val = (x) => (priced ? x.usd ?? 0 : x.tokens ?? 0);
  const max = Math.max(...days.map(val), 1e-9);
  const unpriced = list(u.unpriced);
  const bars = h_flex()
    .h(34)
    .mt(4)
    .gap(5)
    .items_end()
    .children(
      days.map((x, i) => {
        const future = x.date > today;
        const isToday = x.date === today;
        const height = future ? 6 : Math.max(6, Math.round((val(x) / max) * 100));
        return div()
          .id(`home-bar-${i}`)
          .flex_1()
          .h(`${height}%`)
          .rounded_tl(2)
          .rounded_tr(2)
          .bg(future ? k.line.soft : isToday ? withAlpha(k.accent, 0.55) : k.accent)
          .tooltip(`${weekdayOf(x.date)} · ${priced ? money(x.usd) : t("home.spend.tokens", { n: tokensText(x.tokens) })}`);
      }),
    );
  const labels = h_flex().gap(5).children(days.map((x) => Text(weekdayOf(x.date), { size: "xs", tone: x.date === today ? "secondary" : "tertiary" }).flex_1().text_center()));
  const tools = h_flex()
    .gap(10)
    .flex_wrap()
    .children(
      Object.entries(TOOL_LABEL)
        .filter(([key]) => (u.byTool?.[key]?.tokens ?? 0) > 0 || (u.byTool?.[key]?.usd ?? 0) > 0)
        .map(([key, label]) =>
          h_flex()
            .gap(4)
            .items_center()
            .child(Text(label, { size: "xs", tone: "secondary", nowrap: true }))
            .child(Text(money(u.byTool[key].usd), { size: "xs", mono: true, weight: "medium", nowrap: true })),
        ),
    );
  const sub = [t("home.spend.today", { usd: money(u.today?.usd) })];
  if (unpriced.length) sub.push(t("home.spend.unpriced", { n: tokensText(unpriced.reduce((s, x) => s + (x.tokens ?? 0), 0)) }));
  return [
    head,
    h_flex()
      .gap(10)
      .items_end()
      .child(Text(money(u.week?.usd), { size: "xl", weight: "semibold", nowrap: true }))
      .child(Text(sub.join(" · "), { size: "xs", tone: "tertiary", truncate: true }).pb(3).flex_1())
      .when(unpriced.length > 0, (e) => e.tooltip(t("home.spend.unpricedModels", { models: unpriced.map((x) => x.model).join(", ") }))),
    bars,
    labels,
    tools,
  ];
}

export function strip(v, now) {
  const k = tokens();
  return h_flex()
    .id("home-strip")
    .flex_none()
    .w_full()
    .pt(12)
    .border_t(1)
    .border_color(k.line.soft)
    .items_start()
    .child(section(inboxSection(v), true))
    .child(section(todoSection(v)))
    .child(section(routinesSection(v, now)))
    .child(section(spendSection(now)).pr(0));
}

// ---------------------------------------------------------------------------------------------------------------------
// Recent events.

const GH_EVENT = {
  review_requested: ["git-pull-request", "secondary"],
  pr_opened: ["git-pull-request", "secondary"],
  approved: ["check", "success"],
  changes_requested: ["message-square", "error"],
  merged: ["git-merge", "success"],
  ci_failed: ["circle-x", "error"],
  ci_passed: ["circle-check", "success"],
};
const ROUTINE_EVENT = { ok: "success", failed: "error", missed: "warning", "over-budget": "warning" };

/** Every recent event, newest first: `{at, icon, tone, text, detail, open(cx)}`. */
function events(v) {
  const out = [];
  for (const e of list(gh.data()?.recent)) {
    const [icon, tone] = GH_EVENT[e.kind] ?? ["circle-dot", "secondary"];
    const m = /\/([^/]+)\/pull\/(\d+)/.exec(e.url ?? "");
    const ref = m ? `${m[1]}#${m[2]}` : "";
    const rest = String(e.title ?? "").startsWith(ref) ? String(e.title).slice(ref.length).trim() : String(e.title ?? "");
    out.push({ at: e.at, icon, tone, text: t("home.event.gh", { what: t(`home.event.gh.${e.kind}`), ref }), detail: rest, open: (cx) => v.openApp(cx, "inbox", e.url) });
  }
  for (const n of list(routines.data()?.notices)) {
    out.push({ at: n.at, icon: "calendar-clock", tone: ROUTINE_EVENT[n.kind] ?? "secondary", text: t(`home.event.routine.${n.kind}`, { name: n.name }), detail: n.summary ?? "", open: (cx) => v.openApp(cx, "routines", n.slug) });
  }
  for (const a of agentEvents()) {
    out.push({ at: a.at, icon: a.kind === "blocked" ? "hand" : "circle-check", tone: a.kind === "blocked" ? "blocked" : "success", text: t(`home.event.agent.${a.kind}`, { tool: a.tool, project: a.project }), detail: a.task, open: (cx) => v.goAddress(cx, a.address) });
  }
  return out.filter((e) => typeof e.at === "number").sort((a, b) => b.at - a.at).slice(0, 8);
}

function eventsSection(v) {
  const k = tokens();
  const all = events(v);
  const rows = all.map((e, i) =>
    h_flex()
      .id(`home-ev-${i}`)
      .h(k.row.sm)
      .gap(8)
      .items_center()
      .min_w(0)
      .px(4)
      .mx(-4)
      .rounded(k.radius.sm)
      .cursor_pointer()
      .hover((s) => s.bg(k.bg.hover))
      .on_click((_e, cx) => e.open(cx))
      .tooltip(e.detail ? `${e.text} · ${e.detail}` : e.text)
      .child(Text(clock(e.at), { size: "xs", mono: true, tone: "tertiary", nowrap: true }).w(38).flex_none())
      .child(Icon(e.icon, { size: 13, color: e.tone === "secondary" ? k.text.secondary : k.state[e.tone] }))
      .child(Text(e.text, { size: "sm", nowrap: true }).flex_none().max_w("70%").truncate())
      .when(Boolean(e.detail), (el) => el.child(Text(firstLine(e.detail, 120), { size: "sm", tone: "tertiary", truncate: true }).flex_1())),
  );
  return v_flex()
    .flex_1()
    .min_w(0)
    .gap(2)
    .child(SectionHeader({ icon: "history", title: t("home.events.title") }))
    .children(rows.length ? rows : [Text(t("home.events.empty"), { size: "sm", tone: "tertiary" })]);
}

const REASON = { busy: "home.restore.busy", send: "home.restore.sendFailed", timeout: "home.restore.timeout" };

function restoreLine(v, e, i) {
  const k = tokens();
  const state = e.reason ? t(REASON[e.reason]) : e.status === "sent" ? t("home.restore.sent") : t("home.restore.pending");
  const where = [tilde(e.cwd, homeDir()), state].filter(Boolean).join(" · ");
  return h_flex()
    .id(`home-rs-${i}`)
    .min_h(32)
    .gap(8)
    .items_center()
    .min_w(0)
    .child(AgentMark(e.tool, { size: 14, color: k.text.primary }))
    .child(
      v_flex()
        .flex_1()
        .min_w(0)
        .child(Text(`${e.name} · ${e.where}`, { size: "sm", truncate: true }))
        .child(Text(where, { size: "xs", tone: e.status === "failed" ? "error" : "tertiary", truncate: true })),
    )
    .child(IconButton(`home-rs-retry-${i}`, "rotate-ccw", t("home.restore.retryOne", { name: e.name }), { disabled: !v.live || !e.atShell || e.status === "sent", onClick: (_e, cx) => v.retryRestore(cx, [e.address]) }));
}

function restoreSection(v) {
  const r = store.get(STORE.restore);
  const all = [...list(r?.failed), ...list(r?.pending)];
  return v_flex()
    .w(340)
    .flex_none()
    .min_w(0)
    .gap(2)
    .child(
      SectionHeader({
        icon: "rotate-ccw",
        title: t("home.restore.title"),
        count: all.length,
        trailing: all.length ? [Button("home-rs-all", t("home.restore.retryAll"), { size: "sm", kbd: "⌥⌘R", disabled: !v.live, onClick: (_e, cx) => v.retryRestore(cx, null) })] : [],
      }),
    )
    .children(all.length ? all.map((e, i) => restoreLine(v, e, i)) : [Text(t("home.restore.empty"), { size: "sm", tone: "tertiary" })]);
}

export function lower(v) {
  const k = tokens();
  return h_flex()
    .id("home-lower")
    .flex_none()
    .w_full()
    .pt(12)
    .gap(16)
    .border_t(1)
    .border_color(k.line.soft)
    .items_start()
    .child(eventsSection(v))
    .child(Divider({ vertical: true, length: 120 }))
    .child(restoreSection(v));
}
