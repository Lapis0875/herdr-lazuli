// The header over a lone agent's terminal: the work view's agent mode (⌥⌘A, `place: "work"`) and the agent opened
// beside Home (`place: "home"`). It names the agent (program mark, title), its state and how long, its branch, PR,
// CI and ticket as links, then queue a prompt (⌥⌘Q), recap (⌘R), fork its session, and the way back: to the whole
// tab (work) or close / go to its tab (Home).
// Reference: lstack-herdr-cockpit's `agent-head.js` (removed; git history ee5201a).

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { focused, props, run } from "herdr";
import * as fleet from "../sys/fleet.js";
import * as queue from "../sys/queue.js";
import { NODE } from "../sys/state.js";
import { hideInCenter } from "../sys/bus.js";
import { t } from "../core/i18n.js";
import { tokens } from "../ui/tokens.js";
import { ViewRoot, Button, IconButton, ProgramIcon, Spinner, StatusDot, Text, PrChip, CiChip, BranchChip, Chip, Count, Spacer } from "../ui/kit.js";
import { act, canFork } from "./shell/actions.js";
import { agentName, ciLabel, ciState, dur, prState } from "./shell/format.js";

// The header sits inside the layout's card: its fill and rounded corners show through.
const CLEAR = "#00000000";
const num = (v) => typeof v === "number" && Number.isFinite(v);

export default class AgentHead {
  constructor(name) {
    this.name = name;
  }

  init(p, cx) {
    this.props = props() ?? p ?? {};
    this.place = this.props.place === "home" ? "home" : "work";
    this.preview = this.props.preview === true;
    // The elapsed time moves by the minute.
    cx.timer.every(60000, (cx) => cx.notify());
  }

  /** The agent the block shows: Herdr's focused agent, else the focused pane's. */
  agent(rows) {
    const f = focused();
    return rows.find((a) => a.address === f?.agent) ?? rows.find((a) => a.address === f?.terminal) ?? null;
  }

  back(k) {
    if (this.place === "home")
      return [
        IconButton("ah-go", "maximize-2", t("shell.agent.goTab"), { onClick: () => this.go() }),
        IconButton("ah-close", "x", t("shell.agent.close"), { onClick: () => !this.preview && hideInCenter("home-agent") }),
      ];
    return [Button("ah-tab", t("shell.agent.backToTab"), { variant: "ghost", size: "sm", icon: "minimize-2", kbd: "⌥⌘A", onClick: () => !this.preview && run("layout.select", { stack: NODE.view, child: "main" }) })];
  }

  go() {
    if (this.preview) return;
    const a = this.agent(fleet.rows());
    if (a) act({ kind: "go", address: a.address });
  }

  render(_cx) {
    const k = tokens();
    const now = Date.now();
    const a = this.agent(fleet.rows(now));
    const root = ViewRoot("lz-agent-head", { bg: CLEAR })
      .flex_row()
      .items_center()
      .pl(12)
      .pr(6)
      .gap(8)
      .text_size(k.fontSize.sm)
      .line_height(`${k.lineHeight.sm}px`)
      .border_b(1)
      .border_color(k.line.soft);
    if (!a) return root.child(Text(t("shell.agent.none"), { size: "sm", tone: "secondary" })).child(Spacer()).children(this.back(k));

    const since = num(a.since) ? now - a.since : null;
    const state =
      a.status === "working"
        ? Spinner({ size: 12, label: t("shell.stage.working") })
        : StatusDot(a.status === "blocked" ? "blocked" : a.status === "done" ? "done" : "idle", { label: t(`shell.agent.status.${a.status}`) });
    const word = `${t(`shell.agent.status.${a.status}`)}${since !== null && a.status !== "idle" ? ` · ${dur(since)}` : ""}`;
    const ci = ciState(a.pr);
    const queued = queue.itemsFor(a.address)?.length ?? 0;
    const links = [
      a.branch ? BranchChip(a.branch, { tooltip: a.branch }) : null,
      a.pr?.url ? PrChip(a.pr.number, { id: "ah-pr", state: prState(a.pr), tooltip: `${a.pr.title ?? ""}  ⌘G`, onClick: () => !this.preview && act({ kind: "open", url: a.pr.url }) }) : null,
      a.pr?.url && ci ? CiChip(ci, ciLabel(ci), { id: "ah-ci", tooltip: ciLabel(ci), onClick: () => !this.preview && act({ kind: "open", url: `${a.pr.url}/checks` }) }) : null,
      a.ticket?.key
        ? Chip(a.ticket.key, { id: "ah-ticket", icon: "ticket", mono: true, tooltip: `${t("shell.status.ticket")}  ⌘L`, onClick: () => !this.preview && run("lazuli.ticket") })
        : null,
    ].filter(Boolean);

    return root
      .child(ProgramIcon(a.program, { size: 14 }))
      .child(div().flex_shrink(1).min_w(0).truncate().font_weight(k.weight.medium).text_size(k.fontSize.md).text_color(k.text.primary).child(agentName(a)))
      .child(h_flex().flex_none().gap(5).items_center().child(state).child(div().whitespace_nowrap().text_color(a.status === "blocked" ? k.state.blocked : k.text.secondary).child(word)))
      .child(h_flex().flex_shrink(1).min_w(0).gap(4).items_center().overflow_hidden().children(links))
      .child(Spacer())
      .child(
        div()
          .relative()
          .flex_none()
          .child(IconButton("ah-queue", "send", t("shell.agent.queue"), { tooltip: `${t("shell.agent.queue")}  ⌥⌘Q`, onClick: () => !this.preview && queue.open(a.address) }))
          .when(queued > 0, (e) => e.child(Count(queued, { tone: "accent", ring: k.bg.card }).absolute().top(-3).right(-4))),
      )
      .child(IconButton("ah-recap", "sparkles", t("shell.agent.recap"), { tooltip: `${t("shell.agent.recap")}  ⌘R`, onClick: () => !this.preview && act({ kind: "recap", address: a.address }) }))
      .when(canFork(a.address), (e) => e.child(IconButton("ah-fork", "git-fork", t("shell.pane.fork"), { onClick: () => !this.preview && act({ kind: "fork", address: a.address, place: "tab" }) })))
      .children(this.back(k));
  }
}
