// 실행: the Run Inspector, in the panel (cards stacked, children indented) and in its window (a top-down card tree).
// One run of one root: the user message that started it and everything until its final output; ‹ › steps through the
// root's runs. A card is an agent: its status, its task's first line, its latest steps (a model call → its tool's
// result) as bars inside its own lifetime, failed steps kept beyond the latest five, its cost and lifetime. A click on
// a card selects it (the list shares the selection) and the numbers become its part; a click on a row opens the call
// under it. All of it comes from lh-scan.mjs `run`/`call` into this copy; shared state only says which run and call.

import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { tokens, alpha, TEXT, RADIUS, Icon, Button, Chip, Mono, Empty, Skeleton } from "./ui.js";
import {
  rootsFor, selection, select, isOpen, setOpen, runOf, setRunIndex, refreshRun, openCall, setOpenCall, callOf, ensureCall,
  duration,
} from "./lh-tree-data.js";
import { EstTag, goTo } from "./lh-ui.js";

const TOOL_ICONS = {
  read: "file-text", write: "file-plus", edit: "pencil", ast_edit: "code", eval: "code", lsp: "code", bash: "terminal",
  grep: "search", glob: "folder", find: "folder", web_search: "globe", browser: "globe", fetch: "globe", task: "workflow",
  wait: "hourglass", job: "activity", todo: "list-todo", todo_write: "list-todo", ask: "message-circle", irc: "message-square",
  yield: "send", submit: "send", debug: "bug", notebook: "book", image: "image", model: "sparkles",
};
const AGENT_ICONS = {
  scout: "scan-eye", explore: "search", task: "bot", "ui-designer": "palette", reviewer: "shield-check",
  "backend-implementer": "server", implementer: "code", architect: "map", plan: "map", tester: "square-check",
};
const STATUS = {
  running: ["실행 중", "working", "loader"], blocked: ["입력 대기", "blocked", "hand"], done: ["완료", "done", "check"],
  failed: ["실패", "destructive", "circle-x"], aborted: ["중단", "destructive", "circle-stop"], terminal: ["터미널", "mutedFg", "terminal"],
};
const NUMBERS = [["시간", "ms"], ["비용", "cost"], ["토큰", "tokens"], ["모델 호출", "modelCalls"], ["도구 호출", "toolCalls"], ["오류", "errors"]];
const NARROW = 300;
const live = (s) => s === "running" || s === "blocked";

export function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 10) return `${s.toFixed(1)}s`;
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(Math.floor(s % 60)).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}
const fmtCost = (c) => (!c ? "$0" : c < 0.01 ? `$${c.toFixed(3)}` : `$${c.toFixed(2)}`);
const fmtTokens = (n) => (n < 1000 ? String(n) : n < 1e6 ? (n < 1e4 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`) : `${(n / 1e6).toFixed(1)}M`);
const toolIcon = (t) => (t?.startsWith("mcp__") ? "server" : TOOL_ICONS[t] ?? "wrench");

function pill(status, { est = false, iconOnly = false } = {}) {
  const k = tokens();
  const [label, tone, icon] = STATUS[status] ?? STATUS.running;
  if (iconOnly) return h_flex().id(`lh-pill-${status}`).size(22).flex_none().items_center().justify_center().rounded(RADIUS.md).bg(alpha(k[tone], 0.12)).tooltip(label).child(Icon(icon, { size: 12, color: k[tone] }));
  return Chip(est && live(status) ? `≈ ${label}` : label, { color: k[tone], icon });
}

const sep = () => div().px(5).text_color(tokens().dim).child("·");

/** Where a card's step sits in its lifetime: a 6 px track (or a 2 px hairline when narrow), a segment at `at`. */
function bar(row, width, liveColor) {
  const k = tokens();
  const color = row.err ? k.destructive : row.running ? liveColor : row.tool === "model" ? alpha(k.mutedFg, 0.6) : alpha(k.ring, 0.65);
  const len = row.running ? 1 - row.at : row.len;
  const h = width == null ? 2 : 6;
  const seg = div().absolute().top(0).h(h).rounded(h / 2).bg(color).left(`${Math.min(row.at, 0.98) * 100}%`).w(`${Math.max(len, 0.02) * 100}%`).min_w(h === 2 ? 4 : 5);
  return div()
    .relative()
    .h(h)
    .rounded(h / 2)
    .bg(alpha(k.foreground, 0.07))
    .when(width == null, (e) => e.w_full())
    .when(width != null, (e) => e.w(width).flex_none())
    .child(row.running ? seg.loop("opacity", { from: 0.55, to: 1, period: 1200 }) : seg);
}

/** Under an opened row: tool and outcome, error (red) or the result's first lines, the arguments, the step's split. */
function details(row, file) {
  const k = tokens();
  const d = callOf(file, row.id);
  const box = v_flex().mt(4).mb(6).p(10).gap(4).rounded(RADIUS.md).bg(k.muted).on_mouse_down("left", (_e, cx) => cx.stop_propagation());
  if (row.id.startsWith("live-")) return box.child(div().text_size(TEXT.sm).text_color(k.mutedFg).child("모델이 응답을 쓰는 중입니다. 끝나면 기록에 남습니다."));
  if (!d || d.loading) return box.child(div().text_size(TEXT.xs).text_color(k.dim).child("기록 읽는 중…"));
  if (d.error && !d.tool) return box.child(div().text_size(TEXT.sm).text_color(k.destructive).child(`기록을 읽지 못했습니다: ${d.error}`));
  const args = d.args ? Object.entries(d.args).map(([a, v]) => `${a}: ${JSON.stringify(v)}`).join(", ") : "";
  const split = [`단계 ${fmtMs(row.ms)}`, d.modelMs != null ? `모델 ${fmtMs(d.modelMs)}` : null, d.toolMs != null ? `도구 ${fmtMs(d.toolMs)}` : null].filter(Boolean).join(" · ");
  return box
    .child(h_flex().gap(8).child(div().flex_1().min_w(0).truncate().font_family("JetBrains Mono").text_size(TEXT.xs).text_color(k.mutedFg).child(d.model && d.tool === "model" ? `model · ${d.model}` : d.tool)).child(div().text_size(TEXT.xs).font_medium().text_color(d.isError ? k.destructive : d.pending ? k.working : k.success).child(d.isError ? "실패" : d.pending ? "실행 중" : "성공")))
    .when(Boolean(d.error || d.result), (e) => e.child(div().w_full().whitespace_normal().text_size(TEXT.sm).text_color(d.isError ? k.destructive : k.foreground).child(String(d.error || d.result).split("\n").slice(0, 3).join("\n"))))
    .when(Boolean(args), (e) => e.child(h_flex().gap(8).min_w(0).child(div().flex_none().text_size(TEXT.xs).text_color(k.dim).child("호출 인자")).child(div().flex_1().min_w(0).truncate().font_family("JetBrains Mono").text_size(TEXT.xs).child(`{${args}}`))))
    .child(div().truncate().font_family("JetBrains Mono").text_size(TEXT.xs).text_color(k.dim).child(split));
}

/** One agent. `ctx`: {root, run, width, track, selected, faded, kids, est}; an hc terminal node renders as `term`. */
export function Card(c, ctx) {
  const k = tokens();
  const narrow = ctx.width < NARROW;
  const pad = narrow ? 10 : 12;
  const liveColor = c.status === "blocked" ? k.blocked : k.working;
  const call = openCall();
  const toggleSel = (_e, cx) => {
    const sel = selection();
    select(sel && sel.root === ctx.root.address && sel.id === c.id ? null : { root: ctx.root.address, id: c.id });
    cx.notify();
  };
  const tile = h_flex().size(28).flex_none().items_center().justify_center().rounded(RADIUS.md).bg(k.muted).border_1().border_color(k.border);
  const p = ctx.root.program;
  const icon = c.term ? Icon("terminal", { size: 16, color: k.mutedFg })
    : c.id === "" && p?.icon ? (p.tint ? svg(p.icon).size(16).flex_none().text_color(k.foreground) : image(p.icon).w(16).h(16).flex_none())
    : Icon(c.id === "" ? "bot" : AGENT_ICONS[c.agent] ?? "bot", { size: 16, color: k.mutedFg });
  const sub = c.term ? `hc 하위 터미널 · ${c.term.address}` : [c.model, c.id === "" ? null : c.agent].filter(Boolean).join(" · ");
  const status = c.term ? (live(c.status) ? "terminal" : "done") : c.status;
  let el = v_flex()
    .id(`lh-card-${c.id || "root"}`)
    .w(ctx.width)
    .flex_none()
    .p(pad)
    .rounded(RADIUS.lg)
    .bg(alpha(k.muted, 0.55))
    .border_1()
    .border_color(ctx.selected ? k.ring : k.border)
    .cursor_pointer()
    .tab_index(0)
    .focus((s) => s.border_color(k.ring))
    .on_click(toggleSel)
    .on_key_down((e, cx) => {
      if (e.keystroke === "enter" || e.keystroke === "space") {
        cx.stop_propagation();
        toggleSel(e, cx);
      } else if (e.keystroke === "escape" && call) {
        cx.stop_propagation();
        setOpenCall(null);
      }
    })
    .child(
      h_flex()
        .gap(10)
        .items_center()
        .child(tile.child(icon))
        .child(
          v_flex()
            .flex_1()
            .min_w(0)
            .child(h_flex().gap(6).items_center().min_w(0).child(div().flex_shrink_1().min_w(0).truncate().text_size(TEXT.base).font_semibold().child(c.name)).when(c.id === "" && ctx.est, (e) => e.child(EstTag())))
            .child(div().truncate().text_size(TEXT.xs).text_color(k.mutedFg).child(sub)),
        )
        .child(pill(status, { est: ctx.est, iconOnly: narrow })),
    )
    .child(div().mt(8).truncate().text_size(TEXT.sm).text_color(k.mutedFg).child(c.task || " "))
    .child(div().mt(10).mb(6).mx(-pad).h(1).bg(k.border));
  if (c.term) {
    return el
      .child(div().truncate().font_family("JetBrains Mono").text_size(TEXT.sm).child(`$ ${c.name}`))
      .child(div().mt(2).truncate().text_size(TEXT.sm).text_color(k.mutedFg).child(c.term.facts))
      .child(h_flex().mt(8).gap(8).items_center().child(Button(`lh-term-${c.id}`, { label: "이동", icon: "external", variant: "outline", size: "xs", onClick: (_e, cx) => (cx.stop_propagation(), goTo(c.term)) })).child(div().text_size(TEXT.xs).text_color(k.dim).child("터미널은 호출 기록이 없습니다")));
  }
  for (const r of c.rows) {
    const on = Boolean(call && call.root === ctx.root.address && call.card === c.id && call.row === r.id && call.run === ctx.run.index);
    const toggle = (_e, cx) => {
      cx.stop_propagation();
      setOpenCall(on ? null : { root: ctx.root.address, run: ctx.run.index, card: c.id, row: r.id, file: c.file });
      if (!on) ensureCall(cx, c.file, r.id);
      cx.notify();
    };
    const color = r.err ? k.destructive : r.running ? liveColor : k.mutedFg;
    const line = h_flex()
      .gap(8)
      .items_center()
      .child(Icon(toolIcon(r.tool), { size: 14, color }))
      .child(div().flex_1().min_w(0).truncate().text_size(TEXT.sm).text_color(k.foreground).child(r.label))
      .when(!narrow, (e) => e.child(bar(r, ctx.track, liveColor)))
      .child(div().w(46).flex_none().flex().justify_end().child(Mono(`${ctx.est && r.running ? "≈" : ""}${fmtMs(r.ms)}`, { color })));
    el = el.child(
      v_flex()
        .id(`lh-row-${c.id}-${r.id}`)
        .mx(-6)
        .px(6)
        .py(narrow ? 4 : 5)
        .gap(3)
        .rounded(RADIUS.md)
        .cursor_pointer()
        .tab_index(0)
        .focus((s) => s.bg(alpha(k.ring, 0.13)))
        .when(on, (e) => e.bg(alpha(k.ring, 0.13)))
        .when(!on, (e) => e.hover((s) => s.bg(k.accent)))
        .on_click(toggle)
        .on_key_down((e, cx) => {
          if (e.keystroke === "enter" || e.keystroke === "space") toggle(e, cx);
          else if (e.keystroke === "escape" && on) toggle(e, cx);
        })
        .child(line)
        .when(narrow, (e) => e.child(bar(r, null, liveColor))),
    );
    if (on) el = el.child(details(r, c.file));
  }
  const kids = ctx.kids ?? 0;
  return el
    .when(c.more > 0, (e) => e.child(h_flex().h(24).gap(10).items_center().text_size(11.5).text_color(k.mutedFg).child(Icon("scroll-text", { size: 12, color: k.dim })).child(`+${c.more}개 더`)))
    .child(
      h_flex()
        .mt(8)
        .items_center()
        .text_size(TEXT.sm)
        .child(div().font_medium().child(fmtCost(c.cost)))
        .child(sep())
        .child(div().text_color(k.mutedFg).child(`${ctx.est ? "≈ " : ""}${fmtMs(c.ms)}`))
        .child(div().flex_1())
        .when(c.errors > 0, (e) => e.child(div().text_size(11.5).font_medium().text_color(k.destructive).child(`오류 ${c.errors}`)))
        .when(kids > 0, (e) =>
          e.child(
            h_flex()
              .id(`lh-fold-${c.id || "root"}`)
              .ml(10)
              .gap(4)
              .items_center()
              .text_size(11.5)
              .text_color(k.mutedFg)
              .hover((s) => s.text_color(k.foreground))
              .on_click((_e, cx) => {
                cx.stop_propagation();
                setOpen(ctx.root, !isOpen(ctx.root));
                cx.notify();
              })
              .child(`하위 ${kids}`)
              .child(Icon(isOpen(ctx.root) ? "chevron-down" : "chevron-right", { size: 12 })),
          ),
        ),
    )
    .when(ctx.faded, (e) => e.opacity(0.45));
}

/** The selected card's part: its own numbers and its whole subtree's (or the run's when nothing is selected). */
function numbersOf(run, cards, selId) {
  if (selId == null) return run;
  const mine = cards.filter((c) => selId === "" || c.id === selId || c.id.startsWith(`${selId}/`));
  const own = cards.find((c) => c.id === selId);
  const sum = (f) => mine.reduce((a, c) => a + (c[f] ?? 0), 0);
  return { ms: own.ms, cost: sum("cost"), tokens: sum("tokens"), modelCalls: sum("modelCalls"), toolCalls: sum("toolCalls"), errors: sum("errors") };
}

function Numbers(n, cols, scope) {
  const k = tokens();
  const cell = ([label, key]) => {
    const v = n[key] ?? 0;
    const s = key === "ms" ? fmtMs(v) : key === "cost" ? fmtCost(v) : key === "tokens" ? fmtTokens(v) : String(v);
    return v_flex().w(`${100 / cols}%`).py(4).child(div().text_size(TEXT.xs).text_color(k.mutedFg).child(label)).child(div().text_size(14).font_medium().text_color(key === "errors" && v ? k.destructive : k.foreground).child(s));
  };
  return v_flex()
    .px(12)
    .py(6)
    .rounded(RADIUS.lg)
    .border_1()
    .border_color(scope ? alpha(k.ring, 0.7) : k.border)
    .when(Boolean(scope), (e) =>
      e.child(
        h_flex()
          .h(26)
          .mx(-12)
          .px(12)
          .mb(4)
          .gap(6)
          .items_center()
          .border_b_1()
          .border_color(k.border)
          .child(Icon("bot", { size: 12, color: k.ring }))
          .child(div().flex_1().min_w(0).truncate().text_size(11.5).font_medium().text_color(k.ring).child(cols > 2 ? `${scope} 기준 (하위 포함)` : scope))
          .child(
            div()
              .id("lh-scope-clear")
              .text_size(11.5)
              .text_color(k.mutedFg)
              .cursor_pointer()
              .hover((s) => s.text_color(k.foreground))
              .on_click((_e, cx) => (select(null), cx.notify()))
              .child(cols > 2 ? "전체 보기" : "전체"),
          ),
      ),
    )
    .child(h_flex().flex_wrap().children(NUMBERS.map(cell)));
}

/** ✦ the run's task · ‹ n/N › (· the window button); agents · running · cost (· start) and the run's status. */
function Title(root, run, { narrow, onWindow }) {
  const k = tokens();
  const idx = run.index;
  const step = (to) => (_e, cx) => {
    setRunIndex(root.address, to >= run.count - 1 ? null : to);
    refreshRun(cx, root, { force: true });
    cx.notify();
  };
  const start = new Date(run.start);
  return v_flex()
    .gap(6)
    .child(
      h_flex()
        .gap(6)
        .items_center()
        .child(Icon("sparkles", { size: 14, color: k.ring }))
        .child(div().flex_1().min_w(0).truncate().text_size(TEXT.base).font_semibold().child(run.task || "(빈 메시지)"))
        .child(Button("lh-run-prev", { icon: "chevron-left", variant: "ghost", size: "icon-sm", tooltip: "이전 실행", disabled: idx <= 0, onClick: step(idx - 1) }))
        .child(Mono(`${idx + 1}/${run.count}`, { color: k.mutedFg }))
        .child(Button("lh-run-next", { icon: "chevron-right", variant: "ghost", size: "icon-sm", tooltip: "다음 실행", disabled: idx >= run.count - 1, onClick: step(idx + 1) }))
        .when(Boolean(onWindow), (e) => e.child(Button("lh-run-window", { icon: "maximize", variant: "ghost", size: "icon-sm", tooltip: "창으로 크게 보기", onClick: onWindow }))),
    )
    .child(
      h_flex()
        .pl(20)
        .items_center()
        .text_size(11.5)
        .text_color(k.mutedFg)
        .child(`에이전트 ${run.agents}`)
        .when(run.running > 0, (e) => e.child(sep()).child(div().text_color(k.working).child(`실행 중 ${run.running}`)))
        .child(sep())
        .child(div().font_medium().text_color(k.foreground).child(fmtCost(run.cost)))
        .when(!narrow, (e) => e.child(sep()).child(div().text_color(k.dim).child(`${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")} 시작`)))
        .child(div().flex_1())
        .child(pill(run.status)),
    );
}

/** Which root the 실행 view shows: the selection's root among the scope's roots, else the first (the focused). */
export function runRoot(scope) {
  const roots = rootsFor(scope).filter((r) => r.omp && r.session);
  const sel = selection();
  return { roots, root: roots.find((r) => r.address === sel?.root) ?? roots[0] ?? null };
}

/** The cards to draw: the run's, the latest run with the root's hc terminals added, done ones hidden when asked. */
function visibleCards(root, data, hide) {
  let cards = data.cards;
  if (data.run.index === data.run.count - 1)
    cards = [...cards, ...root.kids.filter((n) => n.kind === "terminal").map((n) => ({ id: n.id, parent: "", depth: 1, name: n.name, status: n.live ? "running" : "done", task: n.task, rows: [], more: 0, cost: 0, ms: n.start ? Date.now() - n.start : 0, errors: 0, term: { ...n, facts: [n.task, duration({ status: "working", start: n.start })].filter(Boolean).join(" · ") } }))];
  if (!isOpen(root)) cards = cards.filter((c) => c.depth === 0);
  if (hide) {
    const keep = new Set();
    for (const c of cards) if (c.depth === 0 || live(c.status)) for (let id = c.id; ; id = id.slice(0, Math.max(0, id.lastIndexOf("/")))) {
      keep.add(id);
      if (!id.includes("/")) break;
    }
    cards = cards.filter((c) => keep.has(c.id) || c.depth === 0);
  }
  return cards;
}

/** The body both views share above their cards: root chips (스페이스, several roots), title, numbers. */
function header(root, roots, data, sel, { narrow, cols, onWindow }) {
  const k = tokens();
  const selCard = sel && sel.root === root.address ? data.cards.find((c) => c.id === sel.id) : null;
  return v_flex()
    .gap(10)
    .when(roots.length > 1, (e) =>
      e.child(
        h_flex()
          .flex_wrap()
          .gap(6)
          .children(roots.map((r) => Chip(r.name, { id: `lh-root-${r.address}`, color: r.address === root.address ? k.ring : undefined, icon: r.address === root.address ? "check" : undefined, tooltip: `${r.address} · ${r.task}`, onClick: (_e, cx) => (select({ root: r.address, id: "" }), refreshRun(cx, r, { force: true }), cx.notify()) }))),
      ),
    )
    .child(Title(root, data.run, { narrow, onWindow }))
    .child(Numbers(numbersOf(data.run, data.cards, selCard ? selCard.id : null), cols, selCard?.name ?? null));
}

function state(root) {
  if (!root) return Empty({ icon: "activity", title: "보여 줄 실행이 없습니다", description: "omp가 이 범위에서 일하면 그 실행이 여기에 보입니다." });
  const r = runOf(root);
  if (r.loading) return v_flex().p(12).gap(10).child(Skeleton({ h: 44 })).child(Skeleton({ h: 64 })).child(Skeleton({ h: 180 }));
  if (r.error) return div().p(12).text_size(TEXT.sm).text_color(tokens().destructive).child(`기록을 읽지 못했습니다: ${r.error}`);
  if (!r.data?.run?.count) return Empty({ icon: "activity", title: "아직 실행이 없습니다", description: "이 omp에 메시지를 보내면 첫 실행이 시작됩니다." });
  return null;
}

/**
 * Cards stacked depth-first, each level `step` in (capped at 4), an L connector from the parent's indent to each
 * card's header, the line running on while a later sibling follows. `base`: the depth drawn flush left.
 */
function Stack(cards, { width, step, base, cardOf }) {
  const line = alpha(tokens().ring, 0.55);
  const later = cards.map((c, i) => cards.slice(i + 1).some((d) => d.parent === c.parent));
  return v_flex().children(
    cards.map((c, i) => {
      const d = Math.min(c.depth - base, 4);
      const guides = [];
      for (let L = 1; L <= d; L++) {
        const anc = L === d ? i : cards.findLastIndex((x, j) => j < i && x.depth - base === L);
        const x = (L - 1) * step + step / 2;
        if (L === d) guides.push(div().absolute().left(x).top(0).h(10 + 26).w(step / 2).border_l_1().border_b_1().rounded_bl(6).border_color(line));
        if (anc >= 0 && later[anc]) guides.push(div().absolute().left(x).top(0).bottom(0).w(1).bg(line));
      }
      return div().relative().w(width).pt(i ? 10 : 0).pl(d * step).children(guides).child(cardOf(c, width - d * step));
    }),
  );
}

function cardMaker(root, data, track) {
  const sel = selection();
  const selId = sel && sel.root === root.address && data.cards.some((c) => c.id === sel.id) ? sel.id : null;
  const kids = data.cards.filter((x) => x.depth === 1).length;
  return (c, w) => Card(c, { root, run: data.run, width: w, track, selected: c.id === selId, faded: selId != null && c.id !== selId, kids: c.depth === 0 ? kids : 0, est: root.est });
}

const truncatedNote = (data) => div().text_size(TEXT.xs).text_color(tokens().dim).child(`카드 ${data.truncated.cards}개는 그리지 않았습니다 (최대 300)`);

/** The panel's 실행 view: header, then the cards stacked, each level indented, L connectors in the indent. */
export function RunPanel({ scope, hide, width, onWindow }) {
  const { roots, root } = runRoot(scope);
  const empty = state(root);
  if (empty) return v_flex().flex_1().min_h(0).child(empty);
  const data = runOf(root).data;
  const narrow = width < 340;
  const pad = narrow ? 10 : 12;
  return v_flex()
    .id("lh-run")
    .flex_1()
    .min_h(0)
    .overflow_y_scrollbar()
    .p(pad)
    .gap(14)
    .child(header(root, scope === "space" ? roots : [], data, selection(), { narrow, cols: narrow ? 2 : 3, onWindow }))
    .child(Stack(visibleCards(root, data, hide), { width: Math.max(200, width - 2 * pad), step: narrow ? 14 : 20, base: 0, cardOf: cardMaker(root, data, 56) }))
    .when(data.truncated?.cards > 0, (e) => e.child(truncatedNote(data)));
}

/** The window's 실행: header, the root card centered, its children in rows of up to four under a bus (a spine on
 * the left joins the rows), each child's own subtree stacked under it as in the panel. */
export function RunTree({ scope, hide, width }) {
  const k = tokens();
  const { roots, root } = runRoot(scope);
  const empty = state(root);
  if (empty) return v_flex().flex_1().min_h(0).child(empty);
  const data = runOf(root).data;
  const CW = 320, GAP = 28;
  const cards = visibleCards(root, data, hide);
  const cardOf = cardMaker(root, data, 72);
  const line = alpha(k.ring, 0.6);
  const top = cards.filter((c) => c.depth === 1);
  const cols = Math.max(1, Math.min(4, Math.floor((width - 48 + GAP) / (CW + GAP))));
  const rowsOf = [];
  for (let i = 0; i < top.length; i += cols) rowsOf.push(top.slice(i, i + cols));
  // One width for every row so the spine (x = −14) lines up; a lone row is as wide as its cards.
  const W = rowsOf.length > 1 ? cols * CW + (cols - 1) * GAP : top.length * CW + (top.length - 1) * GAP;
  const rowEls = rowsOf.map((row, ri) => {
    const first = CW / 2, last = (row.length - 1) * (CW + GAP) + CW / 2;
    const more = ri < rowsOf.length - 1;
    const from = rowsOf.length > 1 ? -14 : first;
    return div()
      .relative()
      .w(W)
      .pt(34)
      .child(div().absolute().top(18).left(from).w(last - from + 1).h(1).bg(line))
      .children(row.map((_c, i) => div().absolute().top(18).left(i * (CW + GAP) + CW / 2).w(1).h(16).bg(line)))
      .when(ri === 0, (e) => e.child(div().absolute().top(0).left(W / 2).w(1).h(19).bg(line)))
      .when(ri > 0, (e) => e.child(div().absolute().left(-14).top(0).h(19).w(1).bg(line)))
      .when(more, (e) => e.child(div().absolute().left(-14).top(18).bottom(0).w(1).bg(line)))
      .child(h_flex().gap(GAP).items_start().children(row.map((c) => Stack([c, ...cards.filter((x) => x.id.startsWith(`${c.id}/`))], { width: CW, step: 20, base: 1, cardOf }))));
  });
  return v_flex()
    .id("lh-run-window")
    .flex_1()
    .min_h(0)
    .overflow_y_scrollbar()
    .px(24)
    .py(16)
    .gap(16)
    .items_center()
    .child(div().w(Math.min(width - 48, Math.max(900, W))).child(header(root, scope === "space" ? roots : [], data, selection(), { narrow: false, cols: 6 })))
    .child(v_flex().items_center().child(cardOf(cards.find((c) => c.depth === 0), CW)).children(rowEls))
    .when(data.truncated?.cards > 0, (e) => e.child(truncatedNote(data)));
}

/** The drawn cards' keys ("<root>:<id>") for the seen-failures rule. */
export function drawnKeys(scope, hide) {
  const { root } = runRoot(scope);
  const data = root ? runOf(root).data : null;
  return new Set(data?.cards ? visibleCards(root, data, hide).map((c) => `${root.address}:${c.id}`) : []);
}
