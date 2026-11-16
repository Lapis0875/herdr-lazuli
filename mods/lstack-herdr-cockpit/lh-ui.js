// The call tree's small parts, shared by the panel list, Home's cards and the transcript viewer: status marks, the
// 추정 tag, a node's detail (status, task, 공통 context, result, 기록 열기).

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { openOverlay, run } from "herdr";
import { tokens, TEXT, RADIUS, Icon, Spinner, Button, Chip, Mono } from "./ui.js";
import { Markdown } from "./reader.js";
import { FORK, exactDuration, span, isRunning, detailOf } from "./lh-tree-data.js";

/** The color a status is drawn in. */
export function statusColor(status) {
  const k = tokens();
  return { working: k.working, blocked: k.blocked, done: k.done, idle: k.idle, failed: k.destructive, aborted: k.destructive }[status] ?? k.mutedFg;
}

/**
 * A node's mark, cockpit's marks plus the tree's: working a turning ring, blocked a breathing dot, done a solid dot,
 * idle an empty ring, failed a crossed circle, aborted a stopped one, an hc terminal its prompt glyph.
 */
export function Mark(id, status, { size = 8, terminal = false } = {}) {
  const k = tokens();
  const c = statusColor(status);
  if (terminal && !isRunning(status)) return Icon("terminal", { size: size + 4, color: k.mutedFg });
  if (status === "working") return Spinner({ size: size + 4, color: c });
  if (status === "failed") return Icon("circle-x", { size: size + 4, color: c });
  if (status === "aborted") return Icon("circle-stop", { size: size + 4, color: c });
  if (status === "idle" || status === "unknown" || status === "terminal") return div().size(size).flex_none().rounded(size / 2).border_1().border_color(status === "idle" ? c : k.dim);
  return div()
    .id(`${id}-mark`)
    .size(size)
    .flex_none()
    .rounded(size / 2)
    .bg(c)
    .when(status === "blocked", (e) => e.loop("opacity", { from: 0.35, to: 1, period: 1200 }));
}

/** The 추정 tag: once, on a root whose statuses come from transcripts alone. */
export function EstTag() {
  const k = tokens();
  return h_flex().flex_none().h(16).px(5).items_center().rounded(RADIUS.sm).border_1().border_color(k.dim).text_size(10.5).font_medium().text_color(k.mutedFg).child("추정");
}

const STATUS_CHIP = {
  working: ["실행 중", "working", "loader"],
  blocked: ["입력 대기", "blocked", "hand"],
  done: ["완료", "done", "circle-check"],
  idle: ["유휴", "idle", "circle"],
  failed: ["실패", "destructive", "circle-x"],
  aborted: ["중단", "destructive", "circle-stop"],
  unknown: ["알 수 없음", "mutedFg", "circle-help"],
  terminal: ["터미널", "mutedFg", "terminal"],
};

export function StatusChip(status) {
  const k = tokens();
  const [label, tone, icon] = STATUS_CHIP[status] ?? STATUS_CHIP.unknown;
  return Chip(label, { color: k[tone], icon });
}

/** Opens the read-only live transcript of a subagent (its own window, one per transcript). */
export function openTranscript(n) {
  if (!n?.file) return;
  openOverlay({
    mod: FORK,
    kind: "window",
    key: `lstack-transcript:${n.file}`,
    width: 760,
    height: 0.8,
    props: { app: "transcript", file: n.file, root: n.root, id: n.id, name: n.name, type: n.type },
  });
}

/** Goes to a terminal node: a pane-less hc child peeks, a root terminal comes to the front. */
export function goTo(n) {
  if (n.kind === "terminal") run("terminal.peek", { terminal: n.address });
  else {
    run("agent.focus", { terminal: n.address });
    run("layout.select", { stack: "center", child: "work" });
  }
}

/**
 * A node's detail, the list's expanded row: status, exact duration and time span; the task; the shared 공통
 * context, folded; the result; 기록 열기 (subagents) or 이동 (terminals).
 */
export function NodeDetail(id, n, view, { now = Date.now() } = {}) {
  const k = tokens();
  const ctxOpen = view.ctxOpen.has(n.key);
  const label = (text) => div().text_size(TEXT.xs).font_semibold().text_color(k.mutedFg).child(text);
  const toggle = (set, key) => (e, cx) => {
    cx.stop_propagation();
    if (set.has(key)) set.delete(key);
    else set.add(key);
    cx.notify();
  };
  const lines = (t) => String(t ?? "").split("\n").length;
  const dur = exactDuration(n, now);
  // The prompt, context and result come per node (ensureDetail); until then the first line stands in.
  const d = detailOf(n);
  const task = d?.task || n.task;
  const context = d?.context ?? "";
  const failure = d?.error ?? null;
  const result = d?.result ?? "";
  return v_flex()
    .id(id)
    .w_full()
    .gap(12)
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .child(
      h_flex()
        .gap(8)
        .items_center()
        .flex_wrap()
        .child(StatusChip(n.kind === "terminal" && !isRunning(n.status) ? "terminal" : n.status))
        .when(Boolean(dur), (e) => e.child(Mono(`${n.est ? "≈" : ""}${dur}`, { color: k.foreground })))
        .when(Boolean(span(n)), (e) => e.child(Mono(span(n), { color: k.dim })))
        .when(n.est, (e) => e.child(EstTag()))
        .when(n.kind === "agent" && !d, (e) => e.child(div().text_size(TEXT.xs).text_color(k.dim).child("기록 읽는 중…"))),
    )
    .when(Boolean(task), (e) =>
      e.child(
        v_flex()
          .gap(6)
          .child(label("작업"))
          .child(Markdown(`${id}-task`, task, { size: TEXT.sm })),
      ),
    )
    .when(Boolean(context), (e) =>
      e.child(
        v_flex()
          .gap(6)
          .child(
            h_flex()
              .id(`${id}-ctx`)
              .gap(6)
              .items_center()
              .cursor_pointer()
              .text_color(k.mutedFg)
              .hover((s) => s.text_color(k.foreground))
              .on_click(toggle(view.ctxOpen, n.key))
              .child(Icon(ctxOpen ? "chevron-down" : "chevron-right", { size: 12 }))
              .child(div().text_size(TEXT.sm).font_medium().child("공통 context"))
              .child(div().text_size(TEXT.xs).text_color(k.dim).child(`${lines(context)}줄`)),
          )
          .when(ctxOpen, (e) => e.child(div().pl(14).child(Markdown(`${id}-context`, context, { size: TEXT.sm })))),
      ),
    )
    .when(Boolean(result || failure), (e) =>
      e.child(
        v_flex()
          .gap(6)
          .child(label(failure ? "실패 이유" : isRunning(n.status) ? "마지막 메시지" : "결과"))
          .child(Markdown(`${id}-result`, failure || result, { size: TEXT.sm })),
      ),
    )
    .when(n.kind === "agent" && Boolean(n.file), (e) =>
      e.child(
        h_flex().child(
          Button(`${id}-log`, {
            label: "기록 열기",
            icon: "scroll-text",
            variant: "outline",
            size: "sm",
            tooltip: "이 하위 에이전트의 대화 기록 (읽기 전용, live)",
            onClick: (ev, cx) => {
              cx.stop_propagation();
              openTranscript(n);
            },
          }),
        ),
      ),
    )
    .when(n.kind === "terminal" || (n.kind === "root" && !n.focused), (e) =>
      e.child(h_flex().child(Button(`${id}-go`, { label: "이동", variant: "outline", size: "sm", onClick: (ev, cx) => (cx.stop_propagation(), goTo(n)) }))),
    );
}

export function clip(text, n) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t;
}
