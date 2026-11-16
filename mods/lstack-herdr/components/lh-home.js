// Home's part of the call tree (Home stays a list): a card is one terminal's root agent.
//   Stage: blocked → Needs you as before; else the root or any descendant running → Working; else cockpit's own rule.
//   Card: its direct subagents only. Running ones as rows (the grandchildren as "+N 하위"), the rest as one line
//   "완료 N · 실패 N"; a row opens its prompt in place, with 트리에서 보기 (the work view, the tree tab, that node).
//   A failed descendant leaves the stage alone and puts a red badge on the card.
// The stage is read in every copy that runs fleet(), so it uses countsOf (records and the watcher's small counts);
// the rows need the scan, which the Home copy runs for itself while Home shows (lhHomeWatch).

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { run, shared, setShared } from "herdr";
import { tokens, TEXT, RADIUS, Icon, Badge, Button, CountPill, Mono } from "./ui.js";
import { FORK, KEYS, refresh, rootOf, countsOf, descendants, hasRunning, isRunning, duration, reveal, detailOf, ensureDetail, find, activeChild } from "./lh-tree-data.js";
import { Mark, clip } from "./lh-ui.js";

const failedOf = (root) => descendants(root).filter((n) => n.kind === "agent" && (n.status === "failed" || n.status === "aborted"));

/** Home's init: its own scan while Home shows, and the open row's prompt. */
export function lhHomeWatch(cx) {
  const tick = (cx, force) => {
    if (activeChild("center") !== "home") return;
    refresh(cx, { force });
    const open = shared(KEYS.home);
    if (typeof open === "string" && open.includes(":")) {
      const at = open.indexOf(":");
      ensureDetail(cx, find(open.slice(0, at), open.slice(at + 1)));
    }
  };
  tick(cx, true);
  cx.timer.every(3000, (cx) => tick(cx, false));
}

/** fleet.js's stage, with an agent's running subagents counting as its own work. */
export function lhStage(agent, stage) {
  if (stage === "needs" || stage === "working") return stage;
  return countsOf(agent.address).running > 0 ? "working" : stage;
}

/** The card's timer: an idle root whose children run reads "하위 12m", the time since the first of them started. */
export function lhTimer(card, timer, now) {
  const a = card.agent;
  if (card.kind !== "agent" || !a || card.stage !== "working" || a.status === "working") return timer;
  const root = rootOf(a.address);
  const running = root ? descendants(root).filter((n) => isRunning(n.status) && n.start) : [];
  if (!running.length) return timer;
  const first = running.reduce((m, n) => Math.min(m, n.start), Infinity);
  return `하위 ${duration({ status: "working", start: first }, now)}`;
}

/** The card header's red badge, when a subagent failed (the stage stays as it was). */
export function lhFailBadge(card) {
  if (card.kind !== "agent" || !card.agent) return [];
  const root = rootOf(card.agent.address);
  const failed = Math.max(root ? failedOf(root).length : 0, countsOf(card.agent.address).failed);
  return failed ? [Badge(`실패 ${failed}`, "destructive", { icon: "circle-x" })] : [];
}

function showInTree(root, id) {
  reveal(root, id);
  setShared(KEYS.view, "list");
  run("agent.focus", { terminal: root });
  run("layout.select", { stack: "center", child: "work" });
  setShared(`${FORK}.app`, "work");
  run("layout.select", { stack: "panel-body", child: "tree" });
  run("layout.show", { id: "panel" });
}

/** The card's subagents, between its recap and its facts. */
export function lhCardKids(card, view) {
  if (card.kind !== "agent" || !card.agent) return [];
  const root = rootOf(card.agent.address);
  const kids = root ? root.kids.filter((n) => n.kind === "agent") : [];
  if (!kids.length) return [];
  const k = tokens();
  const running = kids.filter(hasRunning);
  const rest = kids.filter((n) => !hasRunning(n));
  const done = rest.filter((n) => n.status === "done").length;
  const failed = rest.filter((n) => n.status === "failed" || n.status === "aborted").length;
  const other = rest.length - done - failed;
  const openKey = shared(KEYS.home);
  const rows = running.map((n, i) => {
    const open = openKey === n.key;
    const more = descendants(n).length;
    const task = detailOf(n)?.task || n.task;
    const heading = String(task ?? "").split("\n").map((l) => l.trim()).find((l) => /^#{1,6}\s/.test(l))?.replace(/^#+\s*/, "");
    return v_flex()
      .when(i > 0, (e) => e.border_t_1().border_color(k.border))
      .child(
        h_flex()
          .id(`lh-hk-${n.key}`)
          .h(30)
          .px(8)
          .gap(8)
          .items_center()
          .rounded(RADIUS.md)
          .cursor_pointer()
          .when(open, (e) => e.bg(k.selected))
          .when(!open, (e) => e.hover((s) => s.bg(k.accent)))
          .on_click((_e, cx) => {
            cx.stop_propagation();
            setShared(KEYS.home, open ? null : n.key);
            if (!open) ensureDetail(cx, n);
            cx.notify();
          })
          .child(h_flex().w(14).flex_none().justify_center().child(Mark(`lh-hm-${n.key}`, n.status)))
          .child(div().flex_shrink_1().min_w(0).truncate().text_size(12.5).font_medium().text_color(k.foreground).child(n.name))
          .when(Boolean(n.type), (e) => e.child(div().flex_none().text_size(TEXT.xs).text_color(k.dim).child(n.type)))
          .when(more > 0, (e) => e.child(CountPill(`+${more} 하위`)))
          .child(div().flex_1())
          .child(Mono(`${n.est ? "≈" : ""}${duration(n, view.now ?? Date.now())}`, { color: k.mutedFg }))
          .child(Icon(open ? "chevron-down" : "chevron-right", { size: 12, color: k.mutedFg })),
      )
      .when(open, (e) =>
        e.child(
          v_flex()
            .pl(30)
            .pr(12)
            .pt(6)
            .pb(8)
            .gap(4)
            .when(Boolean(heading), (e) => e.child(div().text_size(12.5).font_semibold().text_color(k.foreground).child(heading)))
            .child(div().w_full().whitespace_normal().text_size(TEXT.sm).text_color(k.mutedFg).child(clip(String(task ?? "").split("\n").filter((l) => l.trim() && !/^#{1,6}\s/.test(l.trim())).join(" "), 240) || n.task))
            .child(
              h_flex().pt(4).child(
                Button(`lh-hk-tree-${n.key}`, {
                  label: "트리에서 보기",
                  icon: "workflow",
                  variant: "ghost",
                  size: "sm",
                  onClick: (ev, cx) => {
                    cx.stop_propagation();
                    showInTree(n.root, n.id);
                  },
                }),
              ),
            ),
        ),
      );
  });
  const summary = [done ? `완료 ${done}` : null, failed ? `실패 ${failed}` : null, other ? `그 밖 ${other}` : null].filter(Boolean);
  return [
    v_flex()
      .id(`lh-hkids-${card.key}`)
      .w_full()
      .p(4)
      .rounded(RADIUS.md)
      .border_1()
      .border_color(k.border)
      .children(rows)
      .when(summary.length > 0, (e) =>
        e.child(
          h_flex()
            .h(28)
            .px(8)
            .gap(6)
            .items_center()
            .when(rows.length > 0, (e) => e.border_t_1().border_color(k.border))
            .text_size(TEXT.sm)
            .child(h_flex().w(14).flex_none().justify_center().child(div().size(6).rounded_full().bg(failed && !done ? k.destructive : k.done)))
            .when(done > 0, (e) => e.child(div().text_color(k.mutedFg).child(`완료 ${done}`)))
            .when(done > 0 && (failed > 0 || other > 0), (e) => e.child(div().text_color(k.dim).child("·")))
            .when(failed > 0, (e) => e.child(h_flex().gap(4).items_center().text_color(k.destructive).child(Icon("circle-x", { size: 12 })).child(`실패 ${failed}`)))
            .when(failed > 0 && other > 0, (e) => e.child(div().text_color(k.dim).child("·")))
            .when(other > 0, (e) => e.child(div().text_color(k.mutedFg).child(`그 밖 ${other}`))),
        ),
      ),
  ];
}
