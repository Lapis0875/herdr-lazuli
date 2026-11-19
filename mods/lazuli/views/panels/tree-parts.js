// The call tree's small parts, shared by the tree panel, the run views and the transcript window (behavior of
// lstack-herdr's lh-ui.js and lh-tree-data.js (removed; git history ee5201a) wording):
// status marks and labels, the estimate tag, times in the
// person's language, a node's detail (status, task, shared context, result, open transcript or go to), and going to
// a terminal node.

import { div } from "gpui-kit";
import { h_flex, v_flex, TextView } from "gpui-base";
import { run } from "herdr";
import { t } from "../../core/i18n.js";
import { tokens } from "../../ui/tokens.js";
import { Text, Icon, Spinner, StatusDot, Badge, Button } from "../../ui/kit.js";
import { showCenter } from "../../sys/bus.js";
import { isRunning, detailOf, elapsedMs } from "../../sys/scan.js";
import { openTranscript } from "./tree-actions.js";

const STATUS = {
  working: ["working", "loader"],
  running: ["working", "loader"],
  blocked: ["blocked", "hand"],
  done: ["done", "circle-check"],
  idle: ["idle", "circle"],
  failed: ["error", "circle-x"],
  aborted: ["error", "circle-stop"],
  unknown: ["default", "circle-help"],
  terminal: ["default", "terminal"],
};

/** A status's label: working, blocked, done, idle, failed, aborted, unknown, terminal (`running` reads as working). */
export const statusLabel = (status) => t(`tree.status.${STATUS[status] ? (status === "running" ? "working" : status) : "unknown"}`);

/** A node's mark: working a turning arc, blocked a breathing dot, done a dot, idle a ring, failed a crossed circle,
 *  aborted a stopped one, an hc terminal its prompt glyph. */
export function Mark(status, { terminal = false } = {}) {
  const k = tokens();
  const label = statusLabel(status);
  if (terminal && !isRunning(status)) return Icon("terminal", { size: 13, color: k.text.tertiary });
  if (status === "working" || status === "running") return Spinner({ size: 13, label });
  if (status === "failed") return Icon("circle-x", { size: 13, color: k.state.error });
  if (status === "aborted") return Icon("circle-stop", { size: 13, color: k.state.error });
  if (status === "blocked") return StatusDot("blocked", { pulse: true, label });
  if (status === "done" || status === "idle") return StatusDot(status, { label });
  return StatusDot("unknown", { label });
}

/** A status as a labelled chip. */
export function StatusChip(status) {
  const [tone, icon] = STATUS[status] ?? STATUS.unknown;
  return Badge(statusLabel(status), { tone, icon });
}

/** The estimate tag: statuses read from transcripts alone (no live records). */
export const EstTag = () => Badge(t("tree.est"), { tone: "default" });

/** "<1m", "12m", "1h 5m": a node's time at a glance. */
export function duration(n, now = Date.now()) {
  const ms = elapsedMs(n, now);
  if (ms == null) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return t("tree.time.lt1m");
  if (m < 60) return t("tree.time.min", { m });
  const h = Math.floor(m / 60);
  return m % 60 ? t("tree.time.hourMin", { h, m: m % 60 }) : t("tree.time.hour", { h });
}

/** "2m 14s": a node's exact time, for its detail. */
export function exactDuration(n, now = Date.now()) {
  const ms = elapsedMs(n, now);
  return ms == null ? "" : fmtMs(Math.round(ms / 1000) * 1000);
}

/** A span of ms in the person's language: 120ms, 4.2s, 12s, 3m 05s, 1h 05m. */
export function fmtMs(ms) {
  if (ms == null || !Number.isFinite(ms)) return "";
  if (ms < 1000) return t("tree.time.milli", { n: Math.round(ms) });
  const s = ms / 1000;
  if (s < 10) return t("tree.time.sec", { n: s.toFixed(1) });
  if (s < 60) return t("tree.time.sec", { n: Math.round(s) });
  const m = Math.floor(s / 60);
  if (m < 60) return t("tree.time.minSec", { m, s: String(Math.floor(s % 60)).padStart(2, "0") });
  return t("tree.time.hourMin", { h: Math.floor(m / 60), m: String(m % 60).padStart(2, "0") });
}

/** "14:02" in 24-hour time. */
export function clock(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "14:02–14:08" (or "14:02–" while it runs). */
export function span(n) {
  if (!n.start) return "";
  return `${clock(n.start)}–${isRunning(n.status) || !n.end ? "" : clock(n.end)}`;
}

/** Text in the code font at a size step, for times and numbers. */
export function Mono(text, { color, size = "xs" } = {}) {
  const k = tokens();
  return div().flex_none().whitespace_nowrap().font_family(k.fonts.mono).text_size(k.fontSize[size]).text_color(color ?? k.text.secondary).child(String(text));
}

/** Markdown from a transcript (a task, a result), in the UI text size. */
export function Markdown(id, text, { size = "sm" } = {}) {
  const k = tokens();
  return div().w_full().min_w(0).text_size(k.fontSize[size]).text_color(k.text.primary).child(TextView.markdown(id, String(text ?? "")).selectable(true));
}

/** Goes to a terminal node: an hc child without a pane peeks; a root terminal comes to the front in the work view. */
export function goTo(n) {
  if (n.kind === "terminal") run("terminal.peek", { terminal: n.address });
  else {
    run("agent.focus", { terminal: n.address });
    showCenter("work");
  }
}

/** A node's detail, the list's opened row: status, exact time and span; the task; the shared context, folded; the
 *  result (or the last message while it runs, or why it failed); open its transcript (subagents) or go to it.
 *  `view.ctxOpen`: the node keys whose context shows. `preview`: no buttons that act. */
export function NodeDetail(id, n, view, { now = Date.now(), preview = false, focusedAddress = null } = {}) {
  const k = tokens();
  const open = view.ctxOpen.has(n.key);
  const label = (text) => Text(text, { size: "xs", tone: "secondary", weight: "semibold" });
  const dur = exactDuration(n, now);
  const d = detailOf(n);
  const task = d?.task || n.task;
  const context = d?.context ?? "";
  const failure = d?.error ?? null;
  const result = d?.result ?? "";
  const go = n.kind === "terminal" || (n.kind === "root" && n.address !== focusedAddress);
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
        .when(Boolean(dur), (e) => e.child(Mono(`${n.est ? "≈" : ""}${dur}`, { color: k.text.primary })))
        .when(Boolean(span(n)), (e) => e.child(Mono(span(n), { color: k.text.tertiary })))
        .when(Boolean(n.est), (e) => e.child(EstTag()))
        .when(n.kind === "agent" && !d, (e) => e.child(Text(t("tree.detail.reading"), { size: "xs", tone: "tertiary" }))),
    )
    .when(Boolean(task), (e) => e.child(v_flex().gap(6).child(label(t("tree.detail.task"))).child(Markdown(`${id}-task`, task))))
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
              .text_color(k.text.secondary)
              .hover((s) => s.text_color(k.text.primary))
              .on_click((_e, cx) => {
                if (!view.ctxOpen.delete(n.key)) view.ctxOpen.add(n.key);
                cx.notify();
              })
              .child(Icon(open ? "chevron-down" : "chevron-right", { size: 12 }))
              .child(div().text_size(k.fontSize.sm).font_weight(k.weight.medium).child(t("tree.detail.context")))
              .child(Text(t("tree.detail.lines", { count: context.split("\n").length }), { size: "xs", tone: "tertiary" })),
          )
          .when(open, (e) => e.child(div().pl(14).child(Markdown(`${id}-context`, context)))),
      ),
    )
    .when(Boolean(result || failure), (e) =>
      e.child(
        v_flex()
          .gap(6)
          .child(label(t(failure ? "tree.detail.failure" : isRunning(n.status) ? "tree.detail.last" : "tree.detail.result")))
          .child(Markdown(`${id}-result`, failure || result)),
      ),
    )
    .when(!preview && n.kind === "agent" && Boolean(n.file), (e) =>
      e.child(
        h_flex().child(
          Button(`${id}-log`, t("tree.detail.transcript"), {
            size: "sm",
            icon: "scroll-text",
            tooltip: t("tree.detail.transcriptHint"),
            onClick: (_e, cx) => {
              cx.stop_propagation();
              openTranscript(n);
            },
          }),
        ),
      ),
    )
    .when(!preview && go, (e) =>
      e.child(h_flex().child(Button(`${id}-go`, t("tree.go"), { size: "sm", icon: "external", onClick: (_e, cx) => { cx.stop_propagation(); goTo(n); } }))),
    );
}
