// A subagent's transcript (`view: "transcript"`, "Open transcript" in the call tree;
// behavior of lstack-herdr's lh-transcript.js (removed; git history ee5201a), new UI): read-only and live.
// Every two seconds the view asks sys/scan.js for what was appended
// to the child's .jsonl (whole entries, at most 300 per read and 6,000 characters each) and keeps the task and the
// latest MAX_ITEMS entries. It never resumes, forks or writes to the session: there is no input here.
// While the child runs the view follows the end: new entries scroll into view unless the person scrolled up, and
// following resumes at the bottom (wheel, End, or "Latest"). A finished transcript opens at the top.
// Props: {file, root, id, name, type, overlay}. A preview copy reads nothing.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { props, closeOverlay, checking } from "herdr";
import { t } from "../core/i18n.js";
import { tokens, withAlpha } from "../ui/tokens.js";
import { ViewRoot, Text, Icon, IconButton, Button, Badge, Kbd, Spinner, Spacer } from "../ui/kit.js";
import { find, isRunning, refresh, detailOf, ensureDetail, readTranscript, TRANSCRIPT_POLL_MS } from "../sys/scan.js";
import { StatusChip, duration, Markdown, Mono } from "./panels/tree-parts.js";
import { stopPress } from "./panels/common.js";

const TOOL_ICONS = { read: "file-text", write: "pencil", edit: "pencil", bash: "terminal", grep: "search", glob: "search", task: "workflow", wait: "hourglass", web_search: "globe", ast_edit: "code", eval: "code" };
const MAX_ITEMS = 200;
const LINE = 40;
// How close to the bottom counts as "at the bottom" (a wheel tick rarely lands exactly on it).
const SLACK = 6;
const TASK_LINES = 8;

const hms = (ms) => {
  if (!ms) return "";
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
};

export default class Transcript {
  constructor(name) {
    this.name = name;
  }

  init(_props, cx) {
    this.p = props() ?? {};
    this.preview = this.p.preview === true;
    this.items = [];
    this.task = null;
    this.reading = false;
    this.offset = 0;
    this.seq = 0;
    // y: how far the content is scrolled; follow: pinned to the end (null until the first render knows if it runs).
    this.scroll = { y: 0, follow: null, view: 0, content: 0 };
    this.loaded = this.preview;
    this.error = null;
    this.fullTask = false;
    this.ctxOpen = false;
    this.closed = false;
    this.handle = cx.focus_handle();
    cx.timer.after(1, () => this.handle.focus());
    if (this.preview || checking()) return;
    const tick = (cx, force) => {
      refresh(cx, { force });
      ensureDetail(cx, find(this.p.root, this.p.id));
    };
    tick(cx, true);
    cx.timer.every(5000, (cx) => tick(cx, false));
    cx.spawn((cx) => this.read(cx));
    // One read at a time: a slow read skips the beats it overlaps instead of queueing behind them.
    cx.timer.every(TRANSCRIPT_POLL_MS, (cx) => {
      if (this.closed || this.reading) return;
      cx.spawn((cx) => this.read(cx));
    });
  }

  close() {
    this.closed = true;
  }

  focus() {
    this.handle.focus();
  }

  shut() {
    if (this.p.overlay && !this.preview) closeOverlay(this.p.overlay);
  }

  async read(cx) {
    this.reading = true;
    try {
      if (!this.p.file) throw new Error(t("tree.transcript.noFile"));
      const out = await readTranscript(this.p.file, this.offset);
      if (out.reset) {
        this.items = [];
        this.task = null;
      }
      const fresh = out.items ?? [];
      for (const it of fresh) {
        if (it.kind === "task") this.task ??= it;
        else this.items.push({ ...it, seq: this.seq++ });
      }
      if (this.items.length > MAX_ITEMS) this.items.splice(0, this.items.length - MAX_ITEMS);
      this.offset = out.offset ?? this.offset;
      const first = !this.loaded || this.error;
      this.error = null;
      this.loaded = true;
      if (first || fresh.length || out.reset) cx.notify();
    } catch (e) {
      this.error = String(e?.message ?? e);
      this.loaded = true;
      cx.notify();
    } finally {
      this.reading = false;
    }
  }

  render(_cx) {
    const k = tokens();
    const node = find(this.p.root, this.p.id);
    const status = node?.status ?? "unknown";
    const live = isRunning(status);
    const started = this.task?.ts ?? node?.start ?? null;
    const dur = node ? duration(node) : "";
    const meta = [this.p.root, String(this.p.id ?? "").split("/").join(" › "), started ? t("tree.transcript.started", { time: hms(started).slice(0, 5) }) : null, dur ? t(live ? "tree.transcript.elapsed" : "tree.transcript.took", { time: dur }) : null].filter(Boolean).join(" · ");
    const type = this.p.type ?? node?.type ?? null;
    return ViewRoot("transcript-root")
      .track_focus(this.handle)
      .on_mouse_down("left", () => this.handle.focus())
      .on_key_down((e, cx) => {
        if (e.keystroke === "escape") {
          cx.stop_propagation();
          this.shut();
          return;
        }
        if (this.scrollKey(e.keystroke)) {
          cx.stop_propagation();
          cx.notify();
        }
      })
      .child(
        h_flex()
          .h(52)
          .flex_none()
          .px(20)
          .gap(10)
          .items_center()
          .border_b_1()
          .border_color(k.line.soft)
          .child(Icon("scroll-text", { size: 16, color: k.text.secondary }))
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .child(
                h_flex()
                  .gap(8)
                  .items_center()
                  .min_w(0)
                  .child(Text(this.p.name ?? this.p.id ?? t("tree.transcript.subagent"), { weight: "semibold", truncate: true }).flex_shrink_1())
                  .when(Boolean(type), (e) => e.child(Badge(type)))
                  .child(StatusChip(status)),
              )
              .child(Text(meta, { size: "xs", tone: "secondary", truncate: true })),
          )
          .child(
            h_flex()
              .id("transcript-live")
              .h(20)
              .px(8)
              .gap(6)
              .flex_none()
              .items_center()
              .rounded(k.radius.md)
              .border_1()
              .border_color(k.line.soft)
              .tooltip(t(live ? "tree.transcript.liveOn" : "tree.transcript.liveOff"))
              .child(div().size(6).rounded(k.radius.full).bg(live ? k.state.success : k.text.tertiary).when(live, (e) => e.loop("opacity", { from: 0.4, to: 1, period: 1400 })))
              .child(Text(t("tree.transcript.live"), { size: "xs", weight: "medium" })),
          )
          .child(stopPress(IconButton("transcript-close", "x", t("common.close"), { tooltip: `${t("common.close")}  esc`, onClick: () => this.shut() }))),
      )
      .child(this.body(k, node, status, live))
      .child(
        h_flex()
          .h(36)
          .flex_none()
          .px(20)
          .gap(10)
          .items_center()
          .border_t_1()
          .border_color(k.line.soft)
          .child(Text(t("tree.transcript.readOnly"), { size: "xs", tone: "secondary", weight: "medium" }))
          .child(Spacer())
          .child(h_flex().gap(6).items_center().child(Kbd("esc")).child(Text(t("common.close"), { size: "xs", tone: "tertiary" })))
          .child(Text(String(this.p.file ?? "").replace(/^.*\/sessions\/[^/]+\//, "…/"), { size: "xs", tone: "tertiary", mono: true, truncate: true }).max_w(320)),
      );
  }

  /** The body, scrolled by the view itself so it can follow the end: the content sits at -y inside a clipped box,
   *  the wheel and keys move y, and while following y is pinned to the bottom as the content grows. */
  body(k, node, status, live) {
    const s = this.scroll;
    s.follow ??= live;
    const max = Math.max(0, s.content - s.view);
    if (s.follow) s.y = max;
    s.y = Math.max(0, Math.min(max, s.y));
    const content = v_flex()
      .id("transcript-content")
      .absolute()
      .left(0)
      .right(0)
      .top(-s.y)
      .px(28)
      .py(20)
      .gap(18)
      .on_size_change((size, cx) => {
        const h = Math.max(0, size.height || 0);
        if (Math.abs(h - s.content) > 0.5) {
          s.content = h;
          cx.notify();
        }
      })
      .when(!this.loaded, (e) => e.child(h_flex().gap(8).items_center().child(Spinner({ size: 14 })).child(Text(t("tree.detail.reading"), { size: "sm", tone: "secondary" }))))
      .when(this.preview && !this.task, (e) => e.child(Text(t("tree.transcript.preview"), { size: "sm", tone: "tertiary" })))
      .when(Boolean(this.error), (e) => e.child(Text(t("tree.readFailed", { error: this.error }), { size: "sm", tone: "error" })))
      .when(Boolean(this.task), (e) => e.child(this.taskBlock(k, node)))
      .children(this.stream(k, status));
    const thumbH = s.content > 0 ? Math.max(24, (s.view / s.content) * s.view) : 0;
    const thumbTop = max > 0 ? (s.y / max) * (s.view - thumbH) : 0;
    return div()
      .id("transcript-body")
      .relative()
      .flex_1()
      .min_h(0)
      .w_full()
      .overflow_hidden()
      .role("log")
      .on_mouse_down("left", (_e, cx) => {
        this.handle.focus();
        cx.stop_propagation();
      })
      .on_size_change((size, cx) => {
        const h = Math.max(0, size.height || 0);
        if (Math.abs(h - s.view) > 0.5) {
          s.view = h;
          cx.notify();
        }
      })
      .on_scroll_wheel((e, cx) => {
        this.scrollBy(-(e.delta?.y ?? 0));
        cx.notify();
      })
      .child(content)
      .when(max > 0, (e) => e.child(div().absolute().right(3).w(4).rounded(2).bg(withAlpha(k.text.secondary, 0.35)).top(thumbTop).h(thumbH)))
      .when(!s.follow && max > SLACK, (e) =>
        e.child(
          div().absolute().bottom(12).right(20).child(
            Button("transcript-follow", t("tree.transcript.latest"), {
              size: "sm",
              icon: "arrow-down",
              tooltip: t("tree.transcript.latestHint"),
              onClick: (_e, cx) => {
                s.follow = true;
                cx.notify();
              },
            }),
          ),
        ),
      );
  }

  /** Scrolls by dy (down positive); at the bottom it follows the end again, anywhere above it stops following. */
  scrollBy(dy) {
    const s = this.scroll;
    const max = Math.max(0, s.content - s.view);
    s.y = Math.max(0, Math.min(max, s.y + dy));
    s.follow = s.y >= max - SLACK;
  }

  /** End follows the end, Home goes to the top, arrows and pages move. True when it was one of them. */
  scrollKey(key) {
    const s = this.scroll;
    if (key === "end") {
      s.follow = true;
      return true;
    }
    if (key === "home") {
      s.follow = false;
      s.y = 0;
      return true;
    }
    const page = Math.max(LINE, s.view * 0.9);
    const dy = { down: LINE, up: -LINE, pagedown: page, pageup: -page, space: page, "shift-space": -page }[key];
    if (dy === undefined) return false;
    this.scrollBy(dy);
    return true;
  }

  taskBlock(k, node) {
    const lines = this.task.text.split("\n");
    const long = lines.length > TASK_LINES + 2;
    const shown = this.fullTask || !long ? this.task.text : lines.slice(0, TASK_LINES).join("\n");
    const context = detailOf(node)?.context ?? "";
    const toggle = (id, open, label, onClick) =>
      h_flex()
        .id(id)
        .gap(6)
        .items_center()
        .cursor_pointer()
        .text_color(k.text.secondary)
        .hover((s) => s.text_color(k.text.primary))
        .on_click(onClick)
        .child(Icon(open ? "chevron-down" : "chevron-right", { size: 12 }))
        .child(div().text_size(k.fontSize.sm).font_weight(k.weight.medium).child(label));
    return v_flex()
      .w_full()
      .p(14)
      .gap(10)
      .rounded(k.radius.lg)
      .bg(k.bg.surface)
      .border_1()
      .border_color(k.line.soft)
      .child(h_flex().child(Text(t("tree.detail.task"), { size: "xs", tone: "secondary", weight: "semibold" }).flex_1()).child(Mono(t("tree.transcript.taskMeta", { time: hms(this.task.ts), count: lines.length }), { color: k.text.tertiary })))
      .child(Markdown("transcript-task", shown))
      .when(long, (e) =>
        e.child(
          toggle("transcript-full", this.fullTask, this.fullTask ? t("tree.transcript.less") : t("tree.transcript.more", { count: lines.length - TASK_LINES }), (_e, cx) => {
            this.fullTask = !this.fullTask;
            cx.notify();
          }),
        ),
      )
      .when(Boolean(context), (e) =>
        e
          .child(div().h(1).w_full().bg(k.line.soft))
          .child(
            toggle("transcript-ctx", this.ctxOpen, `${t("tree.detail.context")} · ${t("tree.transcript.contextHint", { count: context.split("\n").length })}`, (_e, cx) => {
              this.ctxOpen = !this.ctxOpen;
              cx.notify();
            }),
          )
          .when(this.ctxOpen, (x) => x.child(Markdown("transcript-ctx-md", context))),
      );
  }

  /** Messages as blocks; a run of tool calls as one bordered group, each call's outcome on its row. */
  stream(k, status) {
    const results = new Map(this.items.filter((i) => i.kind === "result").map((i) => [i.id, i]));
    const out = [];
    let group = [];
    const flush = () => {
      if (!group.length) return;
      const rows = group;
      group = [];
      out.push(
        v_flex()
          .w_full()
          .rounded(k.radius.lg)
          .border_1()
          .border_color(k.line.soft)
          .overflow_hidden()
          .children(
            rows.map((it, i) => {
              const r = results.get(it.id);
              const state = !r
                ? isRunning(status)
                  ? h_flex().gap(6).items_center().child(Text(t("tree.status.working"), { size: "xs", tone: "working", weight: "medium" })).child(Spinner({ size: 12 }))
                  : Icon("circle-dashed", { size: 14, color: k.text.tertiary })
                : Icon(r.ok ? "check" : "x", { size: 14, color: r.ok ? k.state.success : k.state.error });
              return h_flex()
                .id(`transcript-tool-${it.seq}`)
                .h(32)
                .px(12)
                .gap(10)
                .items_center()
                .when(i > 0, (e) => e.border_t_1().border_color(k.line.soft))
                .when(Boolean(it.intent), (e) => e.tooltip(it.intent))
                .child(Icon(TOOL_ICONS[it.tool] ?? "wrench", { size: 14, color: k.text.secondary }))
                .child(Text(it.tool ?? "", { size: "sm", tone: "secondary", mono: true, truncate: true }).w(64).flex_none())
                .child(Text(it.arg || it.intent || "", { size: "sm", mono: true, truncate: true }).flex_1())
                .child(state)
                .child(Mono(hms(it.ts).slice(0, 5), { color: k.text.tertiary }));
            }),
          ),
      );
    };
    for (const it of this.items) {
      if (it.kind === "tool") {
        group.push(it);
        continue;
      }
      if (it.kind === "result" || it.kind === "task") continue;
      flush();
      if (it.kind === "assistant") out.push(this.message(k, t("tree.transcript.agent"), it));
      else if (it.kind === "user") out.push(this.message(k, t("tree.transcript.message"), it));
      else if (it.kind === "error") out.push(this.message(k, t("tree.transcript.error"), it, true));
      else if (it.kind === "exit") {
        out.push(h_flex().gap(8).items_center().child(div().flex_1().h(1).bg(k.line.soft)).child(Text(t("tree.transcript.exit", { time: hms(it.ts) }), { size: "xs", tone: "tertiary", nowrap: true })).child(div().flex_1().h(1).bg(k.line.soft)));
      }
    }
    flush();
    return out;
  }

  message(k, who, it, error = false) {
    return v_flex()
      .w_full()
      .gap(6)
      .child(h_flex().child(Text(who, { size: "xs", tone: error ? "error" : "secondary", weight: "semibold" }).flex_1()).child(Mono(hms(it.ts), { color: k.text.tertiary })))
      .child(Markdown(`transcript-m-${it.seq}`, it.text, { size: "md" }));
  }
}
