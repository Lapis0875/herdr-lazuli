// 기록 열기: a subagent's transcript, read-only and live. The mod tails the child's .jsonl (lh-scan.mjs reads what was
// appended since the last read, one whole entry at a time, at most 300 entries and 6 000 characters each) every two
// seconds and redraws per message; the window keeps the task and the latest MAX_ITEMS entries. It never resumes,
// forks or writes to the session: there is no input here, and no Copy, Resume or Fork.
// While the child runs the view follows the end: new entries scroll into view unless the person scrolled up, and
// following resumes when they come back to the bottom (wheel, End, or 최신으로). A finished transcript opens at the top.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { props, closeOverlay, exec, appHome, settings } from "herdr";
import { tokens, alpha, TEXT, RADIUS, Icon, Button, Chip, Mono, Spinner, Skeleton, Kbd } from "./ui.js";
import { Markdown } from "./reader.js";
import { FORK, find, isRunning, duration, refresh, detailOf, ensureDetail } from "./lh-tree-data.js";
import { StatusChip } from "./lh-ui.js";

const TOOL_ICONS = { read: "file-text", write: "pencil", edit: "pencil", bash: "terminal", grep: "search", glob: "search", task: "workflow", wait: "hourglass", web_search: "globe", ast_edit: "code", eval: "code" };
const MAX_ITEMS = 200;
const POLL_MS = 2000;
const LINE = 40;
// How close to the bottom counts as "at the bottom" (a wheel tick rarely lands exactly on it).
const SLACK = 6;

const hm = (ms) => {
  if (!ms) return "";
  const d = new Date(ms);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, "0")).join(":");
};

export default class LhTranscript {
  init(_props, cx) {
    this.p = props() ?? {};
    this.items = [];
    this.task = null;
    this.reading = false;
    this.offset = 0;
    this.seq = 0;
    // y: how far the content is scrolled; follow: pinned to the end (null until the first render knows if it runs).
    this.scroll = { y: 0, follow: null, view: 0, content: 0 };
    this.loaded = false;
    this.error = null;
    this.fullTask = false;
    this.ctxOpen = false;
    this.closed = false;
    this.handle = cx.focus_handle();
    cx.timer.after(1, () => this.handle.focus());
    const tick = (cx, force) => {
      refresh(cx, { force });
      ensureDetail(cx, find(this.p.root, this.p.id));
    };
    tick(cx, true);
    cx.timer.every(5000, (cx) => tick(cx, false));
    cx.spawn((cx) => this.read(cx));
    // One read at a time: a slow read skips the beats it overlaps instead of queueing behind them.
    cx.timer.every(POLL_MS, (cx) => {
      if (this.closed || this.reading) return;
      cx.spawn((cx) => this.read(cx));
    });
  }

  close() {
    this.closed = true;
  }

  async read(cx) {
    this.reading = true;
    try {
      await this.readOnce(cx);
    } finally {
      this.reading = false;
    }
  }

  async readOnce(cx) {
    if (!this.p.file) {
      this.error = "transcript path missing";
      cx.notify();
      return;
    }
    try {
      const r = await exec("node", [`${appHome()}/mods/${FORK}/lh-scan.mjs`, "transcript", this.p.file, String(this.offset)]);
      const out = JSON.parse(r.stdout || "{}");
      if (out.error) throw new Error(out.error);
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
      this.error = null;
      if (!this.loaded || fresh.length || out.reset) {
        this.loaded = true;
        cx.notify();
      }
    } catch (e) {
      this.error = String(e?.message ?? e);
      this.loaded = true;
      cx.notify();
    }
  }

  render(cx) {
    const k = tokens();
    const node = find(this.p.root, this.p.id);
    const status = node?.status ?? "unknown";
    const live = isRunning(status);
    const close = () => closeOverlay(props().overlay);
    const stop = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());
    const task = this.task;
    const started = task?.ts ?? node?.start ?? null;
    const meta = [this.p.root, String(this.p.id ?? "").split("/").join(" › "), started ? `${hm(started).slice(0, 5)} 시작` : null, node && duration(node) ? `${duration(node)}${live ? " 경과" : ""}` : null].filter(Boolean).join(" · ");
    return v_flex()
      .id("lh-transcript")
      .track_focus(this.handle)
      .size_full()
      .bg(k.background)
      .text_color(k.foreground)
      .on_mouse_down("left", () => this.handle.focus())
      .on_key_down((e, cx) => {
        if (e.keystroke === "escape") {
          cx.stop_propagation();
          close();
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
          .border_color(k.border)
          .child(Icon("scroll-text", { size: 16, color: k.mutedFg }))
          .child(
            v_flex()
              .flex_1()
              .min_w(0)
              .child(
                h_flex()
                  .gap(8)
                  .items_center()
                  .min_w(0)
                  .child(div().flex_shrink_1().min_w(0).truncate().font_semibold().child(this.p.name ?? this.p.id ?? "하위 에이전트"))
                  .when(Boolean(this.p.type ?? node?.type), (e) => e.child(Chip(this.p.type ?? node.type)))
                  .child(StatusChip(status)),
              )
              .child(div().truncate().text_size(TEXT.xs).text_color(k.mutedFg).child(meta)),
          )
          .child(
            h_flex()
              .h(20)
              .px(8)
              .gap(6)
              .flex_none()
              .items_center()
              .rounded(RADIUS.md)
              .border_1()
              .border_color(k.border)
              .tooltip(live ? "실행 중: 새 메시지가 오는 대로 보입니다" : "끝난 기록: 다시 시작하면 이어서 보입니다")
              .id("lh-live")
              .child(div().id("lh-live-dot").size(6).rounded_full().bg(live ? k.success : k.dim).when(live, (e) => e.loop("opacity", { from: 0.4, to: 1, period: 1400 })))
              .child(div().text_size(TEXT.xs).font_medium().child("live")),
          )
          .child(stop(Button("lh-transcript-close", { icon: "x", variant: "ghost", size: "icon-sm", tooltip: "닫기  esc", onClick: close }))),
      )
      .child(this.body(task, node, status, live))
      .child(
        h_flex()
          .h(36)
          .flex_none()
          .px(20)
          .gap(10)
          .items_center()
          .border_t_1()
          .border_color(k.border)
          .child(div().size(6).rounded_full().bg(live ? k.success : k.dim))
          .child(div().text_size(TEXT.xs).font_medium().text_color(k.mutedFg).child("live · 메시지 단위 갱신"))
          .child(div().text_size(TEXT.xs).text_color(k.dim).child("읽기 전용"))
          .child(div().flex_1())
          .child(h_flex().gap(6).items_center().text_size(TEXT.xs).text_color(k.dim).child(Kbd("esc")).child("닫기"))
          .child(div().max_w(320).truncate().font_family("JetBrains Mono").text_size(TEXT.xs).text_color(k.dim).child(String(this.p.file ?? "").replace(/^.*\/sessions\/[^/]+\//, "…/"))),
      );
  }

  /**
   * The body, scrolled by the view itself so it can follow the end: the content sits at -y inside a clipped box, the
   * wheel and keys move y, and while following, y is pinned to the bottom as the content grows.
   */
  body(task, node, status, live) {
    const k = tokens();
    const s = this.scroll;
    s.follow ??= live;
    const max = Math.max(0, s.content - s.view);
    if (s.follow) s.y = max;
    s.y = Math.max(0, Math.min(max, s.y));
    const zoom = () => settings().zoom ?? 1;
    const content = v_flex()
      .id("lh-transcript-content")
      .absolute()
      .left(0)
      .right(0)
      .top(-s.y)
      .px(28)
      .py(20)
      .gap(18)
      .on_size_change((size, cx) => {
        const h = Math.max(0, size.height / zoom() || 0);
        if (Math.abs(h - s.content) > 0.5) {
          s.content = h;
          cx.notify();
        }
      })
      .when(!this.loaded, (e) => e.child(Skeleton({ h: 120 })))
      .when(Boolean(this.error), (e) => e.child(div().text_size(TEXT.sm).text_color(k.destructive).child(`기록을 읽지 못했습니다: ${this.error}`)))
      .when(Boolean(task), (e) => e.child(this.taskBlock(task, node)))
      .children(this.stream(status));
    const thumbH = s.content > 0 ? Math.max(24, (s.view / s.content) * s.view) : 0;
    const thumbTop = max > 0 ? (s.y / max) * (s.view - thumbH) : 0;
    return div()
      .id("lh-transcript-body")
      .relative()
      .flex_1()
      .min_h(0)
      .w_full()
      .overflow_hidden()
      .on_mouse_down("left", (_e, cx) => {
        this.handle.focus();
        cx.stop_propagation();
      })
      .on_size_change((size, cx) => {
        const h = Math.max(0, size.height / zoom() || 0);
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
      .when(max > 0, (e) => e.child(div().absolute().right(3).w(4).rounded(2).bg(alpha(k.mutedFg, 0.35)).top(thumbTop).h(thumbH)))
      .when(!s.follow && max > SLACK, (e) =>
        e.child(
          div()
            .absolute()
            .bottom(12)
            .right(20)
            .child(Button("lh-t-follow", { label: "최신으로", icon: "arrow-down", variant: "outline", size: "sm", tooltip: "끝으로 가서 새 메시지를 따라갑니다  end", onClick: (_e, cx) => ((s.follow = true), cx.notify()) })),
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

  /** The body's keys: End follows the end, Home goes to the top, arrows and pages move. True when it was one. */
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

  taskBlock(task, node) {
    const k = tokens();
    const lines = task.text.split("\n");
    const long = lines.length > 10;
    const shown = this.fullTask || !long ? task.text : lines.slice(0, 8).join("\n");
    const context = detailOf(node)?.context ?? "";
    return v_flex()
      .w_full()
      .p(14)
      .gap(10)
      .rounded(RADIUS.lg)
      .bg(k.muted)
      .child(h_flex().child(div().flex_1().text_size(TEXT.xs).font_semibold().text_color(k.mutedFg).child("작업")).child(Mono(`${hm(task.ts)} · ${lines.length}줄`, { color: k.dim })))
      .child(Markdown("lh-t-task", shown, { size: 12.5 }))
      .when(long, (e) =>
        e.child(
          h_flex()
            .id("lh-t-full")
            .gap(6)
            .items_center()
            .cursor_pointer()
            .text_size(TEXT.sm)
            .font_medium()
            .text_color(k.mutedFg)
            .hover((s) => s.text_color(k.foreground))
            .on_click((_e, cx) => {
              this.fullTask = !this.fullTask;
              cx.notify();
            })
            .child(Icon(this.fullTask ? "chevron-up" : "chevron-down", { size: 12 }))
            .child(this.fullTask ? "접기" : `전체 보기 · ${lines.length - 8}줄 더`),
        ),
      )
      .when(Boolean(context), (e) =>
        e
          .child(div().h(1).w_full().bg(k.border))
          .child(
            h_flex()
              .id("lh-t-ctx")
              .gap(6)
              .items_center()
              .cursor_pointer()
              .text_color(k.mutedFg)
              .hover((s) => s.text_color(k.foreground))
              .on_click((_e, cx) => {
                this.ctxOpen = !this.ctxOpen;
                cx.notify();
              })
              .child(Icon(this.ctxOpen ? "chevron-down" : "chevron-right", { size: 12 }))
              .child(div().text_size(TEXT.sm).font_medium().child("공통 context"))
              .child(div().text_size(TEXT.xs).text_color(k.dim).child(`${context.split("\n").length}줄 · 부모의 task 호출이 하위 모두에게 넘긴 context`)),
          )
          .when(this.ctxOpen, (e) => e.child(Markdown("lh-t-ctx-md", context, { size: TEXT.sm }))),
      );
  }

  /** Messages as blocks; a run of tool calls as one bordered group, each call's outcome on its row. */
  stream(status) {
    const k = tokens();
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
          .rounded(RADIUS.lg)
          .border_1()
          .border_color(k.border)
          .overflow_hidden()
          .children(
            rows.map((t, i) => {
              const r = results.get(t.id);
              const pending = !r;
              const state = pending
                ? isRunning(status)
                  ? h_flex().gap(6).items_center().child(div().text_size(TEXT.xs).font_medium().text_color(k.working).child("실행 중")).child(Spinner({ size: 12, color: k.working }))
                  : Icon("minus", { size: 14, color: k.dim })
                : Icon(r.ok ? "check" : "x", { size: 14, color: r.ok ? k.success : k.destructive });
              return h_flex()
                .id(`lh-t-tool-${t.seq}`)
                .h(32)
                .px(12)
                .gap(10)
                .items_center()
                .when(i > 0, (e) => e.border_t_1().border_color(k.border))
                .when(Boolean(t.intent), (e) => e.tooltip(t.intent))
                .child(Icon(TOOL_ICONS[t.tool] ?? "wrench", { size: 14, color: k.mutedFg }))
                .child(div().w(52).flex_none().truncate().font_family("JetBrains Mono").text_size(TEXT.sm).text_color(k.mutedFg).child(t.tool ?? ""))
                .child(div().flex_1().min_w(0).truncate().font_family("JetBrains Mono").text_size(TEXT.sm).text_color(k.foreground).child(t.arg || t.intent || ""))
                .child(state)
                .child(Mono(hm(t.ts).slice(0, 5), { color: k.dim }));
            }),
          ),
      );
    };
    this.items.forEach((it) => {
      if (it.kind === "tool") {
        group.push(it);
        return;
      }
      if (it.kind === "result" || it.kind === "task") return;
      flush();
      if (it.kind === "assistant") out.push(this.message("에이전트", it, k.foreground));
      else if (it.kind === "user") out.push(this.message("메시지", it, k.foreground));
      else if (it.kind === "error") out.push(this.message("오류", it, k.destructive));
      else if (it.kind === "exit") out.push(h_flex().gap(8).items_center().text_size(TEXT.xs).text_color(k.dim).child(div().flex_1().h(1).bg(k.border)).child(`세션 종료 · ${hm(it.ts)}`).child(div().flex_1().h(1).bg(k.border)));
    });
    flush();
    return out;
  }

  message(who, it, color) {
    const k = tokens();
    return v_flex()
      .w_full()
      .gap(6)
      .child(h_flex().child(div().flex_1().text_size(TEXT.xs).font_semibold().text_color(color === k.destructive ? color : k.mutedFg).child(who)).child(Mono(hm(it.ts), { color: k.dim })))
      .child(Markdown(`lh-t-m-${it.seq}`, it.text, { size: TEXT.base }));
  }
}
