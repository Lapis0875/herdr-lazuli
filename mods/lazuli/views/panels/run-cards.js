// The run view's cards (behavior of lstack-herdr's lh-run.js (removed; git history ee5201a), new UI):
// one run of one root — the message that
// started it and everything until its final output — as cards, stacked in the panel (children indented, L connectors)
// and as a top-down tree in the run window. A card is an agent: status, its task's first line, its latest steps (a
// model call, a tool's result) as bars inside its own lifetime, failed steps kept beyond the latest five, cost and
// time. A click on a card selects it (the list shares the selection) and the numbers become its part; a click on a
// step opens the call under it. ‹ › step through the root's runs. Data: sys/scan.js `run`/`call`.

import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { t } from "../../core/i18n.js";
import { tokens, withAlpha } from "../../ui/tokens.js";
import { Text, Icon, IconButton, Chip, Empty, Spinner, Spacer } from "../../ui/kit.js";
import {
  rootsFor, selection, select, isOpen, setOpen, runOf, setRunIndex, refreshRun, openCall, setOpenCall, callOf, ensureCall,
} from "../../sys/scan.js";
import { EstTag, StatusChip, statusLabel, fmtMs, clock, duration, goTo, Mono } from "./tree-parts.js";

const TOOL_ICONS = {
  read: "file-text", write: "file-plus", edit: "pencil", ast_edit: "code", eval: "code", lsp: "code", bash: "terminal",
  grep: "search", glob: "folder", find: "folder", web_search: "globe", browser: "globe", fetch: "globe", task: "workflow",
  wait: "hourglass", job: "activity", todo: "list-todo", todo_write: "list-todo", ask: "message-square", irc: "message-square",
  yield: "send", submit: "send", debug: "wrench", notebook: "file-text", image: "image", model: "sparkles",
};
const AGENT_ICONS = {
  scout: "scan-eye", explore: "search", task: "bot", "ui-designer": "palette", reviewer: "shield-check",
  "backend-implementer": "server", implementer: "code", architect: "map", plan: "map", tester: "circle-check",
};
const NUMBERS = [["time", "ms"], ["cost", "cost"], ["tokens", "tokens"], ["modelCalls", "modelCalls"], ["toolCalls", "toolCalls"], ["errors", "errors"]];
const NARROW = 300;
const live = (s) => s === "running" || s === "blocked";
const toolIcon = (tool) => (tool?.startsWith("mcp__") ? "server" : TOOL_ICONS[tool] ?? "wrench");
const fmtCost = (c) => (!c ? "$0" : c < 0.01 ? `$${c.toFixed(3)}` : `$${c.toFixed(2)}`);
const fmtTokens = (n) => (n < 1000 ? String(n) : n < 1e6 ? (n < 1e4 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`) : `${(n / 1e6).toFixed(1)}M`);
const rowLabel = (r) => r.label || (r.code ? t(`tree.code.${r.code}`) : "");

function sep(k) {
  return div().px(5).text_color(k.text.tertiary).child("·");
}

/** A status as a chip, or (narrow) as a glyph with its label as the tooltip. */
function pill(status, { est = false, iconOnly = false, id } = {}) {
  const k = tokens();
  if (!iconOnly) return est && live(status) ? h_flex().gap(4).items_center().child(Mono("≈")).child(StatusChip(status)) : StatusChip(status);
  const color = status === "failed" || status === "aborted" ? k.state.error : live(status) ? k.state[status === "running" ? "working" : status] : k.text.tertiary;
  const icon = { running: "loader", blocked: "hand", done: "check", failed: "circle-x", aborted: "circle-stop", terminal: "terminal" }[status] ?? "circle";
  return h_flex().id(id).size(22).flex_none().items_center().justify_center().rounded(k.radius.md).bg(withAlpha(color, 0.12)).tooltip(statusLabel(status)).child(Icon(icon, { size: 12, color }));
}

/** Where a step sits in its card's lifetime: a 6 px track (2 px when narrow), its segment at `at`. */
function bar(row, width, liveColor) {
  const k = tokens();
  const color = row.err ? k.state.error : row.running ? liveColor : row.tool === "model" ? withAlpha(k.text.secondary, 0.6) : withAlpha(k.accent, 0.65);
  const len = row.running ? 1 - row.at : row.len;
  const h = width == null ? 2 : 6;
  const seg = div().absolute().top(0).h(h).rounded(h / 2).bg(color).left(`${Math.min(row.at, 0.98) * 100}%`).w(`${Math.max(len, 0.02) * 100}%`).min_w(h === 2 ? 4 : 5);
  return div()
    .relative()
    .h(h)
    .rounded(h / 2)
    .bg(withAlpha(k.text.primary, 0.07))
    .map((e) => (width == null ? e.w_full() : e.w(width).flex_none()))
    .child(row.running ? seg.loop("opacity", { from: 0.55, to: 1, period: 1200 }) : seg);
}

/** Under an opened step: tool and outcome, the error or the result's first lines, the arguments, the time split. */
function callDetails(row, file) {
  const k = tokens();
  const d = callOf(file, row.id);
  const box = v_flex().mt(4).mb(6).p(10).gap(4).rounded(k.radius.md).bg(k.bg.surface).on_mouse_down("left", (_e, cx) => cx.stop_propagation());
  if (row.id.startsWith("live-")) return box.child(Text(t("tree.call.writing"), { size: "sm", tone: "secondary" }));
  if (!d || d.loading) return box.child(Text(t("tree.detail.reading"), { size: "xs", tone: "tertiary" }));
  if (d.error && !d.tool) return box.child(Text(t("tree.readFailed", { error: d.error }), { size: "sm", tone: "error" }));
  const args = d.args ? Object.entries(d.args).map(([a, v]) => `${a}: ${JSON.stringify(v)}`).join(", ") : "";
  const split = [t("tree.call.step", { time: fmtMs(row.ms) }), d.modelMs != null ? t("tree.call.model", { time: fmtMs(d.modelMs) }) : null, d.toolMs != null ? t("tree.call.tool", { time: fmtMs(d.toolMs) }) : null].filter(Boolean).join(" · ");
  const outcome = d.isError ? ["tree.call.failed", "error"] : d.pending ? ["tree.call.running", "working"] : ["tree.call.ok", "success"];
  return box
    .child(h_flex().gap(8).child(Text(d.model && d.tool === "model" ? `model · ${d.model}` : d.tool, { size: "xs", tone: "secondary", mono: true, truncate: true }).flex_1()).child(Text(t(outcome[0]), { size: "xs", tone: outcome[1], weight: "medium" })))
    .when(Boolean(d.error || d.result), (e) => e.child(Text(String(d.error || d.result).split("\n").slice(0, 3).join("\n"), { size: "sm", tone: d.isError ? "error" : "primary" })))
    .when(Boolean(d.retryMs), (e) => e.child(Text(t("tree.retry", { time: fmtMs(d.retryMs) }), { size: "xs", tone: "warning" })))
    .when(Boolean(args), (e) => e.child(h_flex().gap(8).min_w(0).child(Text(t("tree.call.args"), { size: "xs", tone: "tertiary", nowrap: true })).child(Text(`{${args}}`, { size: "xs", mono: true, truncate: true }).flex_1())))
    .child(Text(split, { size: "xs", tone: "tertiary", mono: true, truncate: true }));
}

/** One agent's card. `ctx`: {root, run, width, track, selected, faded, kids, est, preview}. */
export function RunCard(c, ctx) {
  const k = tokens();
  const narrow = ctx.width < NARROW;
  const pad = narrow ? 10 : 12;
  const liveColor = c.status === "blocked" ? k.state.blocked : k.state.working;
  const call = openCall();
  const toggleSel = (_e, cx) => {
    if (ctx.preview) return;
    const sel = selection();
    select(sel && sel.root === ctx.root.address && sel.id === c.id ? null : { root: ctx.root.address, id: c.id });
    cx.notify();
  };
  const p = ctx.root.program;
  const icon = c.term
    ? Icon("terminal", { size: 16, color: k.text.secondary })
    : c.id === "" && p?.icon
      ? p.tint ? svg(p.icon).size(16).flex_none().text_color(k.text.primary) : image(p.icon).size(16).flex_none()
      : Icon(c.id === "" ? "bot" : AGENT_ICONS[c.agent] ?? "bot", { size: 16, color: k.text.secondary });
  const sub = c.term ? t("tree.run.terminal", { address: c.term.address }) : [c.model, c.id === "" ? null : c.agent].filter(Boolean).join(" · ");
  const status = c.term ? (live(c.status) ? "terminal" : "done") : c.status;
  let el = v_flex()
    .id(`run-card-${c.id || "root"}`)
    .w(ctx.width)
    .flex_none()
    .p(pad)
    .rounded(k.radius.lg)
    .bg(k.bg.surface)
    .border_1()
    .border_color(ctx.selected ? k.accent : k.line.soft)
    .role("article")
    .accessibility_label(c.name)
    .when(!ctx.preview, (e) =>
      e
        .cursor_pointer()
        .tab_index(0)
        .focus((s) => s.border_color(k.accent))
        .on_click(toggleSel)
        .on_key_down((ev, cx) => {
          if (ev.keystroke === "enter" || ev.keystroke === "space") {
            cx.stop_propagation();
            toggleSel(ev, cx);
          } else if (ev.keystroke === "escape" && call) {
            cx.stop_propagation();
            setOpenCall(null);
          }
        }),
    )
    .child(
      h_flex()
        .gap(10)
        .items_center()
        .child(h_flex().size(28).flex_none().items_center().justify_center().rounded(k.radius.md).bg(k.bg.raised).border_1().border_color(k.line.soft).child(icon))
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .child(h_flex().gap(6).items_center().min_w(0).child(Text(c.name, { weight: "semibold", truncate: true }).flex_shrink_1()).when(c.id === "" && ctx.est, (e) => e.child(EstTag())))
            .child(Text(sub, { size: "xs", tone: "secondary", truncate: true })),
        )
        .child(pill(status, { est: ctx.est, iconOnly: narrow, id: `run-pill-${c.id || "root"}` })),
    )
    .child(Text(c.task || " ", { size: "sm", tone: "secondary", truncate: true }).mt(8))
    .child(div().mt(10).mb(6).mx(-pad).h(1).bg(k.line.soft));
  if (c.term) {
    return el
      .child(Text(`$ ${c.name}`, { size: "sm", mono: true, truncate: true }))
      .child(Text(c.term.facts, { size: "sm", tone: "secondary", truncate: true }).mt(2))
      .child(
        h_flex()
          .mt(8)
          .gap(8)
          .items_center()
          .when(!ctx.preview, (e) => e.child(IconButton(`run-term-${c.id}`, "external", t("tree.go"), { onClick: (_e, cx) => { cx.stop_propagation(); goTo(c.term); } })))
          .child(Text(t("tree.run.noCalls"), { size: "xs", tone: "tertiary" })),
      );
  }
  for (const r of c.rows) {
    const on = Boolean(call && call.root === ctx.root.address && call.card === c.id && call.row === r.id && call.run === ctx.run.index);
    const toggle = (_e, cx) => {
      cx.stop_propagation();
      if (ctx.preview) return;
      setOpenCall(on ? null : { root: ctx.root.address, run: ctx.run.index, card: c.id, row: r.id, file: c.file });
      if (!on) ensureCall(cx, c.file, r.id);
      cx.notify();
    };
    const color = r.err ? k.state.error : r.running ? liveColor : k.text.secondary;
    const line = h_flex()
      .gap(8)
      .items_center()
      .child(Icon(toolIcon(r.tool), { size: 14, color }))
      .child(Text(rowLabel(r), { size: "sm", truncate: true }).flex_1())
      .when(!narrow, (e) => e.child(bar(r, ctx.track, liveColor)))
      .child(h_flex().w(52).flex_none().justify_end().child(Mono(`${ctx.est && r.running ? "≈" : ""}${fmtMs(r.ms)}`, { color })));
    el = el.child(
      v_flex()
        .id(`run-row-${c.id}-${r.id}`)
        .mx(-6)
        .px(6)
        .py(narrow ? 4 : 5)
        .gap(3)
        .rounded(k.radius.md)
        .when(on, (e) => e.bg(withAlpha(k.accent, 0.13)))
        .when(!ctx.preview, (e) =>
          e
            .cursor_pointer()
            .tab_index(0)
            .focus((s) => s.bg(withAlpha(k.accent, 0.13)))
            .when(!on, (x) => x.hover((s) => s.bg(k.bg.hover)))
            .on_click(toggle)
            .on_key_down((ev, cx) => {
              if (ev.keystroke === "enter" || ev.keystroke === "space" || (ev.keystroke === "escape" && on)) toggle(ev, cx);
            }),
        )
        .child(line)
        .when(narrow, (e) => e.child(bar(r, null, liveColor))),
    );
    if (on) el = el.child(callDetails(r, c.file));
  }
  const kids = ctx.kids ?? 0;
  return el
    .when(c.more > 0, (e) => e.child(h_flex().h(24).gap(8).items_center().child(Icon("scroll-text", { size: 12, color: k.text.tertiary })).child(Text(t("tree.run.more", { count: c.more }), { size: "xs", tone: "secondary" }))))
    .when(Boolean(c.error && c.retryMs), (e) => e.child(Text(t("tree.retry", { time: fmtMs(c.retryMs) }), { size: "xs", tone: "warning" }).mt(4)))
    .child(
      h_flex()
        .mt(8)
        .items_center()
        .text_size(k.fontSize.sm)
        .child(Text(fmtCost(c.cost), { size: "sm", weight: "medium" }))
        .child(sep(k))
        .child(Text(`${ctx.est ? "≈ " : ""}${fmtMs(c.ms)}`, { size: "sm", tone: "secondary" }))
        .child(Spacer())
        .when(c.errors > 0, (e) => e.child(Text(t("tree.run.errors", { count: c.errors }), { size: "xs", tone: "error", weight: "medium" })))
        .when(kids > 0, (e) =>
          e.child(
            h_flex()
              .id(`run-fold-${c.id || "root"}`)
              .ml(10)
              .gap(4)
              .items_center()
              .text_size(k.fontSize.xs)
              .text_color(k.text.secondary)
              .hover((s) => s.text_color(k.text.primary))
              .on_click((_e, cx) => {
                cx.stop_propagation();
                if (ctx.preview) return;
                setOpen(ctx.root, !isOpen(ctx.root));
                cx.notify();
              })
              .child(t("tree.run.kids", { count: kids }))
              .child(Icon(isOpen(ctx.root) ? "chevron-down" : "chevron-right", { size: 12 })),
          ),
        ),
    )
    .when(ctx.faded, (e) => e.opacity(0.45));
}

/** The selected card's part (its own time; its whole subtree's counts), or the run's when nothing is selected. */
function numbersOf(run, cards, selId) {
  if (selId == null) return run;
  const mine = cards.filter((c) => selId === "" || c.id === selId || c.id.startsWith(`${selId}/`));
  const own = cards.find((c) => c.id === selId);
  const sum = (f) => mine.reduce((a, c) => a + (c[f] ?? 0), 0);
  return { ms: own.ms, cost: sum("cost"), tokens: sum("tokens"), modelCalls: sum("modelCalls"), toolCalls: sum("toolCalls"), errors: sum("errors") };
}

function Numbers(n, cols, scopeName, preview) {
  const k = tokens();
  const cell = ([label, key]) => {
    const v = n[key] ?? 0;
    const s = key === "ms" ? fmtMs(v) : key === "cost" ? fmtCost(v) : key === "tokens" ? fmtTokens(v) : String(v);
    return v_flex().w(`${100 / cols}%`).py(4).child(Text(t(`tree.num.${label}`), { size: "xs", tone: "secondary" })).child(Text(s, { size: "lg", weight: "medium", tone: key === "errors" && v ? "error" : "primary" }));
  };
  return v_flex()
    .px(12)
    .py(6)
    .rounded(k.radius.lg)
    .border_1()
    .border_color(scopeName ? withAlpha(k.accent, 0.7) : k.line.soft)
    .when(Boolean(scopeName), (e) =>
      e.child(
        h_flex()
          .h(26)
          .mx(-12)
          .px(12)
          .mb(4)
          .gap(6)
          .items_center()
          .border_b_1()
          .border_color(k.line.soft)
          .child(Icon("bot", { size: 12, color: k.accent }))
          .child(Text(cols > 2 ? t("tree.num.scope", { name: scopeName }) : scopeName, { size: "xs", tone: "accent", weight: "medium", truncate: true }).flex_1())
          .when(!preview, (x) =>
            x.child(
              div()
                .id("run-scope-clear")
                .text_size(k.fontSize.xs)
                .text_color(k.text.secondary)
                .cursor_pointer()
                .hover((s) => s.text_color(k.text.primary))
                .on_click((_e, cx) => {
                  select(null);
                  cx.notify();
                })
                .child(t("tree.num.all")),
            ),
          ),
      ),
    )
    .child(h_flex().flex_wrap().children(NUMBERS.map(cell)));
}

/** ✦ the run's task · ‹ n/N › (· the window button); agents · running · cost (· start) and the run's status. */
function Title(root, run, { narrow, onWindow, preview }) {
  const k = tokens();
  const idx = run.index;
  const step = (to) => (_e, cx) => {
    setRunIndex(root.address, to >= run.count - 1 ? null : to);
    refreshRun(cx, root, { force: true });
    cx.notify();
  };
  return v_flex()
    .gap(6)
    .child(
      h_flex()
        .gap(4)
        .items_center()
        .child(Icon("sparkles", { size: 14, color: k.accent }))
        .child(Text(run.task || t("tree.run.emptyTask"), { weight: "semibold", truncate: true }).flex_1().ml(2))
        .child(IconButton("run-prev", "chevron-left", t("tree.run.prev"), { disabled: preview || idx <= 0, onClick: step(idx - 1) }))
        .child(Mono(`${idx + 1}/${run.count}`))
        .child(IconButton("run-next", "chevron-right", t("tree.run.next"), { disabled: preview || idx >= run.count - 1, onClick: step(idx + 1) }))
        .when(Boolean(onWindow) && !preview, (e) => e.child(IconButton("run-window", "maximize-2", t("tree.window.open"), { onClick: onWindow }))),
    )
    .child(
      h_flex()
        .pl(20)
        .items_center()
        .text_size(k.fontSize.xs)
        .text_color(k.text.secondary)
        .child(t("tree.run.agents", { count: run.agents }))
        .when(run.running > 0, (e) => e.child(sep(k)).child(div().text_color(k.state.working).child(t("tree.run.running", { count: run.running }))))
        .child(sep(k))
        .child(div().font_weight(k.weight.medium).text_color(k.text.primary).child(fmtCost(run.cost)))
        .when(!narrow && Boolean(run.start), (e) => e.child(sep(k)).child(div().text_color(k.text.tertiary).child(t("tree.run.started", { time: clock(run.start) }))))
        .child(Spacer())
        .child(pill(run.status)),
    );
}

/** Which root the run view shows: the selection's root among the scope's roots, else the first (the focused). */
export function runRoot(scope) {
  const roots = rootsFor(scope).filter((r) => r.omp && r.session);
  const sel = selection();
  return { roots, root: roots.find((r) => r.address === sel?.root) ?? roots[0] ?? null };
}

/** The cards to draw: the run's (the latest run adds the root's hc terminals), done ones left out when asked. */
function visibleCards(root, data, hide) {
  let cards = data.cards;
  if (data.run.index === data.run.count - 1) {
    cards = [
      ...cards,
      ...root.kids
        .filter((n) => n.kind === "terminal")
        .map((n) => ({ id: n.id, parent: "", depth: 1, name: n.name, status: n.live ? "running" : "done", task: n.task, rows: [], more: 0, cost: 0, ms: n.start ? Date.now() - n.start : 0, errors: 0, term: { ...n, facts: [n.task, duration({ status: "working", start: n.start })].filter(Boolean).join(" · ") } })),
    ];
  }
  if (!isOpen(root)) cards = cards.filter((c) => c.depth === 0);
  if (hide) {
    const keep = new Set();
    for (const c of cards) {
      if (c.depth !== 0 && !live(c.status)) continue;
      for (let id = c.id; ; id = id.slice(0, Math.max(0, id.lastIndexOf("/")))) {
        keep.add(id);
        if (!id.includes("/")) break;
      }
    }
    cards = cards.filter((c) => keep.has(c.id) || c.depth === 0);
  }
  return cards;
}

/** The header both views share above their cards: root chips (several roots), title, numbers. */
function header(root, roots, data, { narrow, cols, onWindow, preview }) {
  const sel = selection();
  const selCard = sel && sel.root === root.address ? data.cards.find((c) => c.id === sel.id) : null;
  return v_flex()
    .gap(10)
    .when(roots.length > 1, (e) =>
      e.child(
        h_flex()
          .flex_wrap()
          .gap(6)
          .children(
            roots.map((r) =>
              Chip(r.name, {
                id: `run-root-${r.address}`,
                icon: r.address === root.address ? "check" : undefined,
                tone: r.address === root.address ? "pr" : "default",
                tooltip: `${r.address} · ${r.task}`,
                onClick: preview ? undefined : (_e, cx) => {
                  select({ root: r.address, id: "" });
                  refreshRun(cx, r, { force: true });
                  cx.notify();
                },
              }),
            ),
          ),
      ),
    )
    .child(Title(root, data.run, { narrow, onWindow, preview }))
    .child(Numbers(numbersOf(data.run, data.cards, selCard ? selCard.id : null), cols, selCard?.name ?? null, preview));
}

/** The run view before its cards: no root, reading, unreadable, no run yet; null once there is a run. */
function emptyState(root) {
  if (!root) return Empty({ id: "run-none", icon: "activity", title: t("tree.run.none.title"), body: t("tree.run.none.body") });
  const r = runOf(root);
  if (r.loading) return v_flex().p(24).gap(8).items_center().child(Spinner({ size: 16 })).child(Text(t("tree.detail.reading"), { size: "sm", tone: "secondary" }));
  if (r.error) return Text(t("tree.readFailed", { error: r.error }), { size: "sm", tone: "error" }).p(12);
  if (!r.data?.run?.count) return Empty({ id: "run-empty", icon: "activity", title: t("tree.run.empty.title"), body: t("tree.run.empty.body") });
  return null;
}

/** Cards depth-first, each level `step` in (capped at 4), an L connector from the parent's indent to each card. */
function Stack(cards, { width, step, base, cardOf }) {
  const line = withAlpha(tokens().accent, 0.55);
  const later = cards.map((c, i) => cards.slice(i + 1).some((d) => d.parent === c.parent));
  return v_flex().children(
    cards.map((c, i) => {
      const d = Math.min(c.depth - base, 4);
      const guides = [];
      for (let L = 1; L <= d; L++) {
        const anc = L === d ? i : cards.findLastIndex((x, j) => j < i && x.depth - base === L);
        const x = (L - 1) * step + step / 2;
        if (L === d) guides.push(div().absolute().left(x).top(0).h(36).w(step / 2).border_l_1().border_b_1().rounded_bl(6).border_color(line));
        if (anc >= 0 && later[anc]) guides.push(div().absolute().left(x).top(0).bottom(0).w(1).bg(line));
      }
      return div().relative().w(width).pt(i ? 10 : 0).pl(d * step).children(guides).child(cardOf(c, width - d * step));
    }),
  );
}

function cardMaker(root, data, track, preview) {
  const sel = selection();
  const selId = sel && sel.root === root.address && data.cards.some((c) => c.id === sel.id) ? sel.id : null;
  const kids = data.cards.filter((x) => x.depth === 1).length;
  return (c, w) => RunCard(c, { root, run: data.run, width: w, track, selected: c.id === selId, faded: selId != null && c.id !== selId, kids: c.depth === 0 ? kids : 0, est: root.est, preview });
}

const truncatedNote = (data) => Text(t("tree.run.truncated", { count: data.truncated.cards }), { size: "xs", tone: "tertiary" });

/** The panel's run view: header, then the cards stacked, each level indented. */
export function RunPanel({ scope, hide, width, onWindow, preview = false }) {
  const { roots, root } = runRoot(scope);
  const empty = emptyState(root);
  if (empty) return v_flex().flex_1().min_h(0).child(empty);
  const data = runOf(root).data;
  const narrow = width < 340;
  const pad = narrow ? 10 : 12;
  return v_flex()
    .id("run-panel")
    .flex_1()
    .min_h(0)
    .overflow_y_scrollbar()
    .p(pad)
    .gap(14)
    .child(header(root, scope === "space" ? roots : [], data, { narrow, cols: narrow ? 2 : 3, onWindow, preview }))
    .child(Stack(visibleCards(root, data, hide), { width: Math.max(200, width - 2 * pad), step: narrow ? 14 : 20, base: 0, cardOf: cardMaker(root, data, 56, preview) }))
    .when(data.truncated?.cards > 0, (e) => e.child(truncatedNote(data)));
}

/** The window's run: header, the root card centered, its children in rows of up to four under a bus, each child's
 *  subtree stacked under it. */
export function RunTree({ scope, hide, width, preview = false }) {
  const k = tokens();
  const { roots, root } = runRoot(scope);
  const empty = emptyState(root);
  if (empty) return v_flex().flex_1().min_h(0).child(empty);
  const data = runOf(root).data;
  const CW = 320;
  const GAP = 28;
  const cards = visibleCards(root, data, hide);
  const cardOf = cardMaker(root, data, 72, preview);
  const line = withAlpha(k.accent, 0.6);
  const top = cards.filter((c) => c.depth === 1);
  const cols = Math.max(1, Math.min(4, Math.floor((width - 48 + GAP) / (CW + GAP))));
  const rowsOf = [];
  for (let i = 0; i < top.length; i += cols) rowsOf.push(top.slice(i, i + cols));
  const W = rowsOf.length > 1 ? cols * CW + (cols - 1) * GAP : top.length * CW + Math.max(0, top.length - 1) * GAP;
  const rowEls = rowsOf.map((row, ri) => {
    const first = CW / 2;
    const last = (row.length - 1) * (CW + GAP) + CW / 2;
    const from = rowsOf.length > 1 ? -14 : first;
    return div()
      .relative()
      .w(W)
      .pt(34)
      .child(div().absolute().top(18).left(from).w(last - from + 1).h(1).bg(line))
      .children(row.map((_c, i) => div().absolute().top(18).left(i * (CW + GAP) + CW / 2).w(1).h(16).bg(line)))
      .when(ri === 0, (e) => e.child(div().absolute().top(0).left(W / 2).w(1).h(19).bg(line)))
      .when(ri > 0, (e) => e.child(div().absolute().left(-14).top(0).h(19).w(1).bg(line)))
      .when(ri < rowsOf.length - 1, (e) => e.child(div().absolute().left(-14).top(18).bottom(0).w(1).bg(line)))
      .child(h_flex().gap(GAP).items_start().children(row.map((c) => Stack([c, ...cards.filter((x) => x.id.startsWith(`${c.id}/`))], { width: CW, step: 20, base: 1, cardOf }))));
  });
  return v_flex()
    .id("run-tree")
    .flex_1()
    .min_h(0)
    .overflow_y_scrollbar()
    .px(24)
    .py(16)
    .gap(16)
    .items_center()
    .child(div().w(Math.min(width - 48, Math.max(900, W))).child(header(root, scope === "space" ? roots : [], data, { narrow: false, cols: 6, preview })))
    .child(v_flex().items_center().child(cardOf(cards.find((c) => c.depth === 0), CW)).children(rowEls))
    .when(data.truncated?.cards > 0, (e) => e.child(truncatedNote(data)));
}

/** The drawn cards' keys ("<root>:<id>"), for the seen-failures rule. */
export function drawnKeys(scope, hide) {
  const { root } = runRoot(scope);
  const data = root ? runOf(root).data : null;
  return new Set(data?.cards ? visibleCards(root, data, hide).map((c) => `${root.address}:${c.id}`) : []);
}
