// The side panel's 에이전트 호출 트리 tab (⌃⌘6) and its 창으로 크게 보기 window.
//   목록: rows two lines high (42), 16 px a level (14 when narrow) up to depth 4, 1 px guides; a click opens a row's
//         detail in place, the chevron folds its children (depth ≥ 2 starts folded); finished rows at 50%.
//   실행: the Run Inspector (lh-run.js): one run of one root as cards, stacked in the panel, a top-down tree in the
//         window.
// Selection, folds, view, scope, the shown run and the opened call are shared state: the list, the 실행 view, the
// window and Home move together.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { shared, setShared, focused, spaces, props, openOverlay, closeOverlay, settings } from "herdr";
import { tokens, alpha, TEXT, RADIUS, Icon, Button, Tabs, Toggle, CountPill, Mono, Empty, Kbd } from "./ui.js";
import {
  FORK, KEYS, refresh, rootsFor, flatten, isOpen, setOpen, selection, select, isSelected, descendants, hasRunning, isRunning,
  duration, markSeen, scanError, ensureDetail, treeShown, appActive, find, refreshRun, openCall, setOpenCall, ensureCall, runOf,
} from "./lh-tree-data.js";
import { Mark, EstTag, NodeDetail, goTo } from "./lh-ui.js";
import { RunPanel, RunTree, runRoot, drawnKeys } from "./lh-run.js";

const ROW = 42;

const stop = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());

function counts(roots) {
  const nodes = roots.flatMap((r) => descendants(r)).filter((n) => n.kind === "agent");
  return { running: nodes.filter((n) => isRunning(n.status)).length, failed: nodes.filter((n) => n.status === "failed" || n.status === "aborted").length };
}

function subtitle(roots, scope, narrow) {
  const f = focused();
  const c = counts(roots);
  const tail = [`실행 ${c.running}`, c.failed ? `실패 ${c.failed}` : null].filter(Boolean);
  if (scope === "space") {
    const space = spaces().find((s) => s.id === f?.space)?.name ?? "스페이스";
    return [space, narrow ? null : `루트 ${roots.length}`, ...tail].filter(Boolean).join(" · ");
  }
  const r = roots[0];
  return r ? [r.address, ...tail].join(" · ") : "";
}

/** The pieces the panel and the window share: state, the scans behind what they show, the scope and hide controls. */
class TreeBase {
  initBase(cx) {
    this.width = 376;
    this.height = 800;
    this.ctxOpen = new Set();
    this.now = Date.now();
    const tick = (cx, force) => {
      // A hidden panel copy reads nothing: the scans and the details are for what someone sees.
      if (!this.showsTree()) return;
      refresh(cx, { force });
      const { scope, hide } = this.state();
      const sel = selection();
      if (sel?.id) ensureDetail(cx, find(sel.root, sel.id));
      if (this.inRun()) {
        const { root } = runRoot(scope);
        if (root) refreshRun(cx, root, { force });
        const c = openCall();
        // A call opened by a command carries no file: its card in the shown run has it.
        const file = c?.file ?? (root && c?.root === root.address ? runOf(root).data?.cards?.find((x) => x.id === c.card)?.file : null);
        if (file && c.row) ensureCall(cx, file, c.row);
      }
      // A failure drawn as a row or card, in a window that is in front, counts as seen: the activity badge goes back
      // to the running count. Folded away, behind another app or on a locked screen, it stays unseen.
      if (this.looking()) markSeen(this.inRun() ? drawnKeys(scope, hide) : new Set(rootsFor(scope).flatMap((r) => flatten(r, isOpen, hide)).map((n) => n.key)));
    };
    tick(cx, true);
    cx.timer.every(3000, (cx) => tick(cx, false));
    // Durations read in minutes: once a half minute is enough.
    cx.timer.every(30000, (cx) => {
      this.now = Date.now();
      cx.notify();
    });
  }

  /** Whether this view's own window has the platform's focus (a timer is a host call, so the window is its own). */
  windowActive() {
    try {
      return Boolean(window.is_window_active());
    } catch {
      return false;
    }
  }

  state() {
    return {
      scope: shared(KEYS.scope) === "space" ? "space" : "focus",
      view: shared(KEYS.view) === "run" ? "run" : "list",
      hide: Boolean(shared(KEYS.hide)),
      sel: selection(),
    };
  }

  scopeTabs() {
    const { scope } = this.state();
    return stop(
      div().child(
        Tabs("lh-scope", {
          items: [{ value: "focus", label: "포커스" }, { value: "space", label: "스페이스" }],
          value: scope,
          onChange: (v, cx) => {
            setShared(KEYS.scope, v);
            refresh(cx, { force: true });
          },
        }),
      ),
    );
  }

  hideToggle(narrow) {
    const k = tokens();
    const { hide } = this.state();
    return stop(
      h_flex()
        .id("lh-hide")
        .gap(8)
        .items_center()
        .flex_none()
        .tooltip("완료 숨기기")
        .child(narrow ? Icon("eye-off", { size: 14, color: k.mutedFg }) : div().text_size(TEXT.sm).text_color(k.mutedFg).child("완료 숨기기"))
        .child(Toggle("lh-hide-toggle", hide, () => setShared(KEYS.hide, !hide))),
    );
  }
}

/** The side panel tab. */
export class LhTree extends TreeBase {
  init(_props, cx) {
    this.initBase(cx);
  }

  /** The panel copy scans while the tree tab is drawn in the layout. */
  showsTree() {
    return treeShown();
  }

  inRun() {
    return this.state().view === "run";
  }

  /** …and someone sees it while the main window is in front. */
  looking() {
    return treeShown() && this.windowActive();
  }

  render(cx) {
    const k = tokens();
    const narrow = this.width < 300;
    const { scope, view, hide } = this.state();
    const roots = rootsFor(scope);
    const sub = roots.length ? subtitle(roots, scope, narrow) : this.emptySubtitle();
    return v_flex()
      .id("lh-tree")
      .size_full()
      .bg(k.background)
      .text_color(k.foreground)
      .on_size_change((s, cx) => {
        const z = settings().zoom ?? 1;
        if (Math.abs(s.width / z - this.width) > 1 || Math.abs(s.height / z - this.height) > 1) {
          this.width = s.width / z;
          this.height = s.height / z;
          cx.notify();
        }
      })
      .child(this.head(narrow, view, sub))
      .child(h_flex().h(40).flex_none().px(12).gap(8).items_center().border_b_1().border_color(k.border).child(this.scopeTabs()).child(div().flex_1()).child(this.hideToggle(narrow)))
      .child(view === "run" ? RunPanel({ scope, hide, width: this.width, onWindow: () => openTreeWindow() }) : roots.length ? this.list(roots, hide, narrow, scope) : this.empty());
  }

  emptySubtitle() {
    const f = focused();
    return [f?.terminal, "에이전트 아님"].filter(Boolean).join(" · ");
  }

  head(narrow, view, sub) {
    const k = tokens();
    return h_flex()
      .h(44)
      .flex_none()
      .px(12)
      .gap(8)
      .items_center()
      .when(!narrow, (e) => e.child(h_flex().size(24).flex_none().rounded(RADIUS.md).items_center().justify_center().bg(alpha(k.ring, 0.14)).child(Icon("workflow", { size: 14, color: k.ring }))))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .child(div().truncate().text_size(TEXT.base).font_semibold().child("에이전트 호출 트리"))
          .child(div().truncate().text_size(TEXT.xs).text_color(k.mutedFg).child(scanError() ? `기록을 읽지 못했습니다: ${scanError()}` : sub)),
      )
      .child(
        Tabs("lh-view", {
          items: [{ value: "list", label: narrow ? "" : "목록", icon: "list" }, { value: "run", label: narrow ? "" : "실행", icon: "activity" }],
          value: view,
          onChange: (v, cx) => {
            setShared(KEYS.view, v);
            const { root } = runRoot(this.state().scope);
            if (v === "run" && root) refreshRun(cx, root, { force: true });
          },
        }),
      );
  }

  empty() {
    const f = focused();
    const space = rootsFor("space");
    const c = counts(space);
    const name = f?.terminal ?? "이 터미널";
    const lines = [`${name}는 에이전트가 아니고 hc 하위 터미널도 없습니다.`, space.length ? `이 스페이스에서는 하위 에이전트 ${c.running}개가 실행 중입니다.` : "이 스페이스에도 호출 트리가 없습니다."];
    return Empty({
      icon: "workflow",
      title: "이 터미널에서 시작된 에이전트가 없습니다",
      description: lines.join("\n"),
      action: space.length ? Button("lh-to-space", { label: "스페이스 범위로 보기", icon: "layers", variant: "outline", size: "sm", onClick: () => setShared(KEYS.scope, "space") }) : undefined,
    });
  }

  list(roots, hide, narrow, scope) {
    const k = tokens();
    const step = narrow ? 14 : 16;
    const indent = (d) => Math.min(d, 4) * step;
    const sel = selection();
    const els = [];
    let hidden = 0;
    roots.forEach((root, ri) => {
      if (ri) els.push(div().h(13).flex_none().flex().items_center().child(div().mx(4).h(1).w_full().bg(k.border)));
      const shown = flatten(root, isOpen, hide);
      if (hide) hidden += flatten(root, isOpen, false).filter((n) => n.status === "done").length - shown.filter((n) => n.status === "done").length;
      shown.forEach((n) => {
        const guides = [];
        for (let L = 0; L < n.depth; L++) guides.push(div().absolute().left(6 + indent(L) + 7).top(0).bottom(-2).w(1).bg(k.border));
        const open = isSelected(n, sel) && n.kind !== "root";
        const row = this.row(n, narrow, indent(n.depth), scope, open);
        els.push(
          div()
            .relative()
            .w_full()
            .flex_none()
            .children(guides)
            .child(
              open
                ? v_flex()
                    .ml(indent(n.depth))
                    .rounded(RADIUS.lg)
                    .bg(k.muted)
                    .child(row)
                    .child(div().pl(24).pr(12).pb(12).child(NodeDetail(`lh-d-${n.key}`, n, this, { now: this.now })))
                : div().ml(indent(n.depth)).child(row),
            ),
        );
      });
    });
    return v_flex()
      .id("lh-list")
      .flex_1()
      .min_h(0)
      .overflow_y_scrollbar()
      .p(6)
      .gap(2)
      .children(els)
      .when(hide && hidden > 0, (e) =>
        e.child(h_flex().h(32).px(10).gap(8).items_center().text_size(TEXT.sm).text_color(k.dim).child(Icon("eye-off", { size: 12, color: k.dim })).child(`완료 ${hidden}개 숨김`)),
      );
  }

  row(n, narrow, _ind, scope, open) {
    const k = tokens();
    const root = n.kind === "root";
    const kids = n.kids.length;
    const folded = kids > 0 && !isOpen(n);
    const failed = n.status === "failed" || n.status === "aborted";
    const go = n.kind === "terminal" || (root && scope === "space" && n.address !== (focused()?.terminal ?? focused()?.agent));
    const dur = n.kind === "terminal" ? "" : duration(n, this.now);
    const durColor = failed ? k.destructive : isRunning(n.status) ? k.mutedFg : k.dim;
    const chevron = h_flex()
      .id(`lh-chev-${n.key}`)
      .w(14)
      .h(18)
      .flex_none()
      .items_center()
      .justify_center()
      .when(kids > 0, (e) =>
        e
          .cursor_pointer()
          .text_color(k.mutedFg)
          .hover((s) => s.text_color(k.foreground))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            setOpen(n, folded);
            cx.notify();
          })
          .child(Icon(folded ? "chevron-right" : "chevron-down", { size: 12 })),
      );
    const typeLine = narrow && n.type && !root;
    let el = v_flex()
      .id(`lh-row-${n.key}`)
      .relative()
      .h(ROW)
      .py(4)
      .pl(6)
      .pr(10)
      .flex_none()
      .rounded(RADIUS.md)
      .cursor_pointer()
      .when(!open, (e) => e.hover((s) => s.bg(k.accent)))
      .on_click((_e, cx) => {
        if (root) setOpen(n, !isOpen(n));
        else {
          select(isSelected(n) ? null : n);
          ensureDetail(cx, n);
        }
        cx.notify();
      })
      .child(
        h_flex()
          .h(18)
          .items_center()
          .child(chevron)
          .child(div().w(4).flex_none())
          .child(h_flex().w(14).flex_none().justify_center().child(Mark(`lh-m-${n.key}`, n.status, { terminal: n.kind === "terminal" })))
          .child(div().w(8).flex_none())
          .child(div().flex_shrink_1().min_w(0).truncate().text_size(TEXT.base).when(root, (e) => e.font_semibold()).when(!root, (e) => e.font_medium()).text_color(k.foreground).child(n.name))
          .when(root && n.est, (e) => e.child(div().ml(6).flex_none().child(EstTag())))
          .when(!narrow && Boolean(n.type) && !root, (e) => e.child(div().ml(6).flex_none().truncate().text_size(TEXT.sm).text_color(k.dim).child(n.type)))
          .child(div().flex_1().min_w(4))
          .when(!go && folded, (e) => e.child(div().mr(8).child(CountPill(`하위 ${kids}`))))
          .when(!go && failed, (e) => e.child(div().mr(8).flex_none().text_size(TEXT.xs).font_medium().text_color(k.destructive).child(n.status === "aborted" ? "중단" : "실패")))
          .when(!go && Boolean(dur), (e) => e.child(Mono(`${n.est && !root ? "≈" : ""}${dur}`, { color: durColor }))),
      )
      .child(
        h_flex()
          .h(16)
          .pl(40)
          .min_w(0)
          .when(go, (e) => e.pr(52))
          .when(typeLine, (e) => e.child(div().flex_none().text_size(TEXT.sm).text_color(k.dim).child(`${n.type} · `)))
          .child(div().flex_1().min_w(0).truncate().text_size(TEXT.sm).text_color(k.mutedFg).child(n.task || (root ? "" : "작업 내용을 기다리는 중…"))),
      )
      .when(go, (e) => e.child(div().absolute().right(8).top(7).child(stop(Button(`lh-go-${n.key}`, { label: "이동", variant: "outline", size: "sm", onClick: (_e, cx) => (cx.stop_propagation(), goTo(n)) })))));
    if (n.status === "done" && !open && !hasRunning(n)) el = el.opacity(0.5);
    return el;
  }
}

export function openTreeWindow() {
  setShared(KEYS.window, openOverlay({ mod: FORK, kind: "window", key: "lstack-herdr-run", width: 0.85, height: 0.9, props: { app: "tree-window" } }));
}

/** Closes the window (its ✕, Esc, or `tree:window:close` from any copy). */
export function closeTreeWindow() {
  const id = shared(KEYS.window);
  setShared(KEYS.window, null);
  if (typeof id === "string") closeOverlay(id);
}

/** 창으로 크게 보기: the shown run as a top-down card tree, the same selection and opened call as the panel. */
export class LhTreeWindow extends TreeBase {
  init(_props, cx) {
    this.initBase(cx);
    this.handle = cx.focus_handle();
    cx.timer.after(1, () => this.handle.focus());
  }

  /** The window scans while it is open, and always shows the 실행 view. */
  showsTree() {
    return true;
  }

  inRun() {
    return true;
  }

  /** Open counts as looking while it, or the main window it floats over, is in front. */
  looking() {
    return this.windowActive() || appActive();
  }

  render(cx) {
    const k = tokens();
    const { scope, hide } = this.state();
    const close = () => {
      setShared(KEYS.window, null);
      closeOverlay(props().overlay);
    };
    const { root } = runRoot(scope);
    return v_flex()
      .id("lh-window")
      .track_focus(this.handle)
      .size_full()
      .bg(k.background)
      .text_color(k.foreground)
      .on_size_change((s, cx) => {
        const z = settings().zoom ?? 1;
        if (Math.abs(s.width / z - this.width) > 1) {
          this.width = s.width / z;
          this.height = s.height / z;
          cx.notify();
        }
      })
      .on_mouse_down("left", () => this.handle.focus())
      .on_key_down((e, cx) => {
        if (e.keystroke !== "escape") return;
        cx.stop_propagation();
        // Esc closes the opened call first, then the window.
        if (openCall()) {
          setOpenCall(null);
          cx.notify();
        } else close();
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
          .child(h_flex().size(24).flex_none().rounded(RADIUS.md).items_center().justify_center().bg(alpha(k.ring, 0.14)).child(Icon("activity", { size: 14, color: k.ring })))
          .child(v_flex().flex_1().min_w(0).child(div().truncate().text_size(TEXT.base).font_semibold().child("에이전트 호출 트리 · 실행")).child(div().truncate().text_size(TEXT.xs).text_color(k.mutedFg).child(root ? root.task : "보여 줄 실행이 없습니다")))
          .child(this.scopeTabs())
          .child(this.hideToggle(false))
          .child(div().w(1).h(24).flex_none().bg(k.border))
          .child(stop(Button("lh-window-close", { icon: "x", variant: "ghost", size: "icon-sm", tooltip: "닫기  esc", onClick: close }))),
      )
      .child(stop(v_flex().flex_1().min_h(0).child(RunTree({ scope, hide, width: this.width }))))
      .child(
        h_flex()
          .h(36)
          .flex_none()
          .px(24)
          .gap(14)
          .items_center()
          .border_t_1()
          .border_color(k.border)
          .text_size(TEXT.xs)
          .text_color(k.mutedFg)
          .child(h_flex().gap(6).items_center().child(Kbd("esc")).child("열린 호출 닫기 · 창 닫기"))
          .child(h_flex().gap(6).items_center().child(Kbd("tab")).child("카드·행 이동"))
          .child(h_flex().gap(6).items_center().child(Kbd("↵")).child("선택 · 펼치기"))
          .child("‹ › 이전·다음 실행 · 휠: 이동")
          .child(div().flex_1())
          .child(div().text_color(k.dim).child("선택은 패널의 목록·실행과 함께 바뀝니다")),
      );
  }
}
