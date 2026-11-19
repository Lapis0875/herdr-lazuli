// The call tree panel (`view: "tree"`, ⌃⌘4; DESIGN A3,
// behavior of lstack-herdr's lh-tree-view.js (removed; git history ee5201a), new UI): the
// agents a terminal started, from sys/scan.js. Two views:
//   List: rows two lines high (16 px a level, 14 when narrow, up to depth 4, 1 px guides); a click opens a row's
//         detail in place (task, shared context, result, open transcript), the chevron folds its children (depth ≥ 2
//         starts folded); finished rows fade.
//   Run:  one run of one root as cards (views/panels/run-cards.js); ⤢ opens it large in its own window (views/run.js).
// Scope: the focused terminal, or every root in the space. Selection, folds, view, scope, the shown run and the
// opened call are shared state: the list, the run view, the window and Home move together.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { focused, spaces, setShared } from "herdr";
import { t } from "../core/i18n.js";
import { tokens } from "../ui/tokens.js";
import { ViewRoot, Text, Icon, IconButton, Button, Segmented, Count, Empty, Spacer } from "../ui/kit.js";
import {
  TREE, refresh, rootsFor, flatten, isOpen, setOpen, selection, select, isSelected, descendants, hasRunning, isRunning,
  scanError, ensureDetail, treeShown, appActive, refreshRun,
} from "../sys/scan.js";
import { TreeBase } from "./panels/tree-base.js";
import { RunPanel, runRoot } from "./panels/run-cards.js";
import { Mark, EstTag, NodeDetail, duration, goTo, Mono } from "./panels/tree-parts.js";
import { openTreeWindow } from "./panels/tree-actions.js";
import { stopPress } from "./panels/common.js";

const ROW = 42;

function counts(roots) {
  const nodes = roots.flatMap((r) => descendants(r)).filter((n) => n.kind === "agent");
  return { running: nodes.filter((n) => isRunning(n.status)).length, failed: nodes.filter((n) => n.status === "failed" || n.status === "aborted").length };
}

const here = () => focused()?.terminal ?? focused()?.agent ?? null;

export default class Tree extends TreeBase {
  init(_props, cx) {
    this.initBase(cx);
    this.handle = cx.focus_handle();
  }

  focus() {
    this.handle.focus();
  }

  /** The panel scans while its tab is drawn in the layout. */
  showsTree() {
    return treeShown();
  }

  inRun() {
    return this.state().view === "run";
  }

  looking() {
    return treeShown() && appActive();
  }

  subtitle(roots, scope, narrow) {
    const c = counts(roots);
    const tail = [t("tree.sub.running", { count: c.running }), c.failed ? t("tree.sub.failed", { count: c.failed }) : null].filter(Boolean);
    if (scope === "space") {
      const space = spaces().find((s) => s.id === focused()?.space)?.name ?? t("tree.scope.space");
      return [space, narrow ? null : t("tree.sub.roots", { count: roots.length }), ...tail].filter(Boolean).join(" · ");
    }
    return roots[0] ? [roots[0].address, ...tail].join(" · ") : [here(), t("tree.sub.notAgent")].filter(Boolean).join(" · ");
  }

  render(_cx) {
    const k = tokens();
    const narrow = this.width < 300;
    const { scope, view, hide } = this.state();
    const roots = rootsFor(scope);
    const error = scanError();
    return this.sized(ViewRoot("tree-root"))
      .track_focus(this.handle)
      .child(this.head(k, narrow, view))
      .child(
        h_flex()
          .h(26)
          .flex_none()
          .px(12)
          .items_center()
          .child(Text(error ? t("tree.readFailed", { error }) : this.subtitle(roots, scope, narrow), { size: "xs", tone: error ? "error" : "tertiary", truncate: true }).flex_1()),
      )
      .child(
        h_flex()
          .h(38)
          .flex_none()
          .px(12)
          .gap(8)
          .items_center()
          .border_b_1()
          .border_color(k.line.soft)
          .child(stopPress(this.scopeControl()))
          .child(Spacer())
          .child(this.hideControl()),
      )
      .child(view === "run" ? RunPanel({ scope, hide, width: this.width, onWindow: () => openTreeWindow(), preview: this.preview }) : roots.length ? this.list(k, roots, hide, narrow, scope) : this.empty());
  }

  head(k, narrow, view) {
    const items = [
      { key: "list", label: t("tree.view.list"), icon: "list" },
      { key: "run", label: t("tree.view.run"), icon: "activity" },
    ];
    return h_flex()
      .h(40)
      .flex_none()
      .pl(12)
      .pr(6)
      .gap(6)
      .items_center()
      .border_b_1()
      .border_color(k.line.soft)
      .child(Icon("workflow", { size: 15, color: k.accent }))
      .child(Text(t("tree.title"), { size: "sm", weight: "semibold", truncate: true }).flex_1())
      .child(
        Segmented("tree-view", items, view, (v, cx) => {
          if (this.preview) return;
          setShared(TREE.view, v);
          const { root } = runRoot(this.state().scope);
          if (v === "run" && root) refreshRun(cx, root, { force: true });
          cx.notify();
        }, { label: t("tree.view.label") }),
      )
      .when(!this.preview, (e) => e.child(IconButton("tree-window", "maximize-2", t("tree.window.open"), { onClick: () => openTreeWindow() })));
  }

  empty() {
    const space = rootsFor("space");
    const c = counts(space);
    const name = here() ?? t("tree.empty.thisTerminal");
    const body = [t("tree.empty.notAgent", { name }), space.length ? t("tree.empty.spaceRunning", { count: c.running }) : t("tree.empty.spaceNone")].join(" ");
    return Empty({
      id: "tree-empty",
      icon: "workflow",
      title: t("tree.empty.title"),
      body,
      action: space.length && !this.preview ? Button("tree-to-space", t("tree.empty.toSpace"), { size: "sm", icon: "layers", onClick: (_e, cx) => { setShared(TREE.scope, "space"); refresh(cx, { force: true }); cx.notify(); } }) : undefined,
    }).flex_1();
  }

  list(k, roots, hide, narrow, scope) {
    const step = narrow ? 14 : 16;
    const indent = (d) => Math.min(d, 4) * step;
    const sel = selection();
    const els = [];
    let hidden = 0;
    roots.forEach((root, ri) => {
      if (ri) els.push(div().h(13).flex_none().flex().items_center().child(div().mx(4).h(1).w_full().bg(k.line.soft)));
      const shown = flatten(root, isOpen, hide);
      if (hide) hidden += flatten(root, isOpen, false).filter((n) => n.status === "done").length - shown.filter((n) => n.status === "done").length;
      for (const n of shown) {
        const guides = [];
        for (let L = 0; L < n.depth; L++) guides.push(div().absolute().left(6 + indent(L) + 7).top(0).bottom(-2).w(1).bg(k.line.soft));
        const open = isSelected(n, sel) && n.kind !== "root";
        const row = this.row(k, n, narrow, scope, open);
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
                    .rounded(k.radius.lg)
                    .bg(k.bg.surface)
                    .border_1()
                    .border_color(k.line.soft)
                    .child(row)
                    .child(div().pl(24).pr(12).pb(12).child(NodeDetail(`tree-d-${n.key}`, n, this, { now: this.now, preview: this.preview, focusedAddress: here() })))
                : div().ml(indent(n.depth)).child(row),
            ),
        );
      }
    });
    return v_flex()
      .id("tree-list")
      .flex_1()
      .min_h(0)
      .overflow_y_scrollbar()
      .p(6)
      .gap(2)
      .role("tree")
      .accessibility_label(t("tree.title"))
      .children(els)
      .when(hide && hidden > 0, (e) =>
        e.child(h_flex().h(32).px(10).gap(8).items_center().child(Icon("eye-off", { size: 12, color: k.text.tertiary })).child(Text(t("tree.hidden", { count: hidden }), { size: "sm", tone: "tertiary" }))),
      );
  }

  row(k, n, narrow, scope, open) {
    const root = n.kind === "root";
    const kids = n.kids.length;
    const folded = kids > 0 && !isOpen(n);
    const failed = n.status === "failed" || n.status === "aborted";
    const go = !this.preview && (n.kind === "terminal" || (root && scope === "space" && n.address !== here()));
    const dur = n.kind === "terminal" ? "" : duration(n, this.now);
    const durColor = failed ? k.state.error : isRunning(n.status) ? k.text.secondary : k.text.tertiary;
    const chevron = h_flex()
      .id(`tree-chev-${n.key}`)
      .w(14)
      .h(18)
      .flex_none()
      .items_center()
      .justify_center()
      .when(kids > 0, (e) =>
        e
          .cursor_pointer()
          .text_color(k.text.secondary)
          .hover((s) => s.text_color(k.text.primary))
          .accessibility_label(t(folded ? "tree.unfold" : "tree.fold"))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            if (this.preview) return;
            setOpen(n, folded);
            cx.notify();
          })
          .child(Icon(folded ? "chevron-right" : "chevron-down", { size: 12 })),
      );
    const typeLine = narrow && n.type && !root;
    let el = v_flex()
      .id(`tree-row-${n.key}`)
      .relative()
      .h(ROW)
      .py(4)
      .pl(6)
      .pr(10)
      .flex_none()
      .rounded(k.radius.md)
      .role("tree_item")
      .aria_level(n.depth + 1)
      .aria_selected(open)
      .accessibility_label(`${n.name} · ${n.task ?? ""}`)
      .when(!this.preview, (e) => {
        const act = (cx) => {
          if (root) setOpen(n, !isOpen(n));
          else {
            select(isSelected(n) ? null : n);
            ensureDetail(cx, n);
          }
          cx.notify();
        };
        return e
          .cursor_pointer()
          .tab_index(0)
          .focus((s) => s.bg(k.bg.hover))
          .when(!open, (x) => x.hover((s) => s.bg(k.bg.hover)))
          .on_click((_e, cx) => act(cx))
          .on_key_down((ev, cx) => {
            if (ev.keystroke !== "enter" && ev.keystroke !== "space") return;
            cx.stop_propagation();
            act(cx);
          });
      })
      .child(
        h_flex()
          .h(18)
          .items_center()
          .child(chevron)
          .child(div().w(4).flex_none())
          .child(h_flex().w(14).flex_none().justify_center().child(Mark(n.status, { terminal: n.kind === "terminal" })))
          .child(div().w(8).flex_none())
          .child(Text(n.name, { weight: root ? "semibold" : "medium", truncate: true }).flex_shrink_1())
          .when(root && n.est, (e) => e.child(div().ml(6).flex_none().child(EstTag())))
          .when(!narrow && Boolean(n.type) && !root, (e) => e.child(Text(n.type, { size: "sm", tone: "tertiary", truncate: true }).ml(6).flex_shrink_1()))
          .child(div().flex_1().min_w(4))
          .when(!go && folded, (e) => e.child(div().mr(8).child(Count(t("tree.kids", { count: kids }), { label: t("tree.kids", { count: kids }) }))))
          .when(!go && failed, (e) => e.child(Text(t(`tree.status.${n.status}`), { size: "xs", tone: "error", weight: "medium", nowrap: true }).mr(8)))
          .when(!go && Boolean(dur), (e) => e.child(Mono(`${n.est && !root ? "≈" : ""}${dur}`, { color: durColor }))),
      )
      .child(
        h_flex()
          .h(16)
          .pl(40)
          .min_w(0)
          .when(go, (e) => e.pr(56))
          .when(Boolean(typeLine), (e) => e.child(Text(`${n.type} · `, { size: "sm", tone: "tertiary", nowrap: true })))
          .child(Text(n.task || (root ? "" : t("tree.waitingTask")), { size: "sm", tone: "secondary", truncate: true }).flex_1()),
      )
      .when(go, (e) =>
        e.child(div().absolute().right(8).top(8).child(stopPress(Button(`tree-go-${n.key}`, t("tree.go"), { size: "sm", onClick: (_e, cx) => { cx.stop_propagation(); goTo(n); } })))),
      );
    if (n.status === "done" && !open && !hasRunning(n)) el = el.opacity(0.5);
    return el;
  }
}
