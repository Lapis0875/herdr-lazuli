// The status bar under the main area (mockup A): the agents by stage (each count goes somewhere), the focused agent's
// program, PR and CI with ⌘G, its ticket with ⌘L, then terminals waiting to be restored (⌥⌘R) and the queued prompts
// (⌥⌘Q). Its layout copy is the owner of the window-wide commands (sys/bus.js routes them to the view named
// "status") and runs the services (views/shell/services.js); a `preview: true` copy only draws.

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { props, run } from "herdr";
import * as store from "../sys/store.js";
import * as fleet from "../sys/fleet.js";
import * as queue from "../sys/queue.js";
import * as scan from "../sys/scan.js";
import { STORE } from "../sys/state.js";
import { showCenter } from "../sys/bus.js";
import { treeCommand } from "./panels/tree-actions.js";
import { t } from "../core/i18n.js";
import { tokens } from "../ui/tokens.js";
import { ViewRoot, Icon, Kbd, StatusDot, ProgramIcon, Spinner, Divider, Spacer, withTooltip } from "../ui/kit.js";
import { startServices, stopServices } from "./shell/services.js";
import { act } from "./shell/actions.js";
import { STAGES, STAGE_DOT, stageCounts, stageLabel, ciState, ciLabel } from "./shell/format.js";

const list = (v) => (Array.isArray(v) ? v : []);
const stop = (_e, cx) => cx.stop_propagation();

// Where each stage's count goes: the next agent of that stage, or Home.
const STAGE_GO = Object.freeze({
  needs: { command: "lazuli.next-waiting", key: "⌘J" },
  working: { show: "home", key: "⌥⌘0" },
  ready: { show: "home", key: "⌥⌘0" },
  done: { command: "lazuli.next:done", key: "⇧⌘U" },
});

export default class Status {
  constructor(name) {
    this.name = name;
  }

  init(p, cx) {
    this.props = props() ?? p ?? {};
    this.preview = this.props.preview === true;
    this.width = 0;
    if (!this.preview) startServices(cx);
  }

  async close() {
    if (!this.preview) await stopServices();
  }

  /** Commands no handler took: the call tree's (`tree:*`; its toasts and views send them). */
  command(c, cx) {
    if (this.preview || typeof c !== "string") return;
    if (c.startsWith("tree:") && !scan.command(c, cx)) treeCommand(c);
  }

  /** One clickable fact of the bar. */
  item(k, id, children, { onClick, tooltip, accent = false } = {}) {
    let el = h_flex()
      .id(id)
      .flex_none()
      .h(24)
      .px(6)
      .gap(6)
      .items_center()
      .rounded(k.radius.md)
      .whitespace_nowrap()
      .text_color(accent ? k.accent : k.text.secondary)
      .children(children);
    if (onClick)
      el = el
        .cursor_pointer()
        .on_mouse_down("left", stop)
        .hover((s) => s.bg(k.bg.hover).text_color(accent ? k.accent : k.text.primary))
        .on_click((_e, cx) => !this.preview && onClick(cx));
    return tooltip ? withTooltip(el, tooltip) : el;
  }

  num(k, n) {
    return div().font_family(k.fonts.mono).font_weight(k.weight.medium).text_color(k.text.primary).child(String(n));
  }

  stages(k, rows, wide) {
    const counts = stageCounts(rows);
    return STAGES.map((stage) => {
      const go = STAGE_GO[stage];
      const label = stageLabel(stage);
      return this.item(k, `st-${stage}`, [StatusDot(STAGE_DOT[stage], { label, pulse: stage === "needs" && counts.needs > 0 }), this.num(k, counts[stage]), wide ? div().child(label) : null].filter(Boolean), {
        tooltip: `${label} · ${t(go.command ? "shell.status.goNext" : "shell.status.goHome")}  ${go.key}`,
        onClick: () => (go.command ? run(go.command) : showCenter(go.show)),
      });
    });
  }

  /** The focused agent: its program and space, PR, CI, ticket. */
  agent(k, a, wide) {
    if (!a) return [];
    const out = [
      withTooltip(
        h_flex().flex_none().gap(6).items_center().min_w(0).child(ProgramIcon(a.program, { size: 14 })).child(div().max_w(220).truncate().text_color(k.text.secondary).child(`${a.program?.name ?? a.app ?? ""} · ${a.space_name ?? ""}`)),
        a.branch ? `${a.title} · ${a.branch}` : a.title,
      ),
    ];
    if (a.pr?.url) {
      out.push(this.item(k, "st-pr", [div().font_family(k.fonts.mono).child(`#${a.pr.number} ↗`)], { accent: true, tooltip: `${a.pr.title ?? ""}  ⌘G`, onClick: () => act({ kind: "open", url: a.pr.url }) }));
      const ci = ciState(a.pr);
      if (ci) {
        const color = { pass: k.state.success, fail: k.state.error, running: k.state.working }[ci];
        const glyph = ci === "running" ? Spinner({ size: 13, color }) : Icon(ci === "pass" ? "circle-check" : "circle-x", { size: 13, color });
        out.push(this.item(k, "st-ci", [glyph, wide ? div().text_color(color).child(ciLabel(ci)) : null].filter(Boolean), { tooltip: ciLabel(ci), onClick: () => act({ kind: "open", url: `${a.pr.url}/checks` }) }));
      }
      out.push(Kbd("⌘G"));
    }
    if (a.ticket?.key) {
      out.push(
        this.item(k, "st-ticket", [Icon("ticket", { size: 13 }), div().font_family(k.fonts.mono).child(a.ticket.url ? `${a.ticket.key} ↗` : a.ticket.key)], {
          accent: Boolean(a.ticket.url),
          tooltip: `${t("shell.status.ticket")}  ⌘L`,
          onClick: () => run("lazuli.ticket"),
        }),
      );
    }
    return out;
  }

  render(_cx) {
    const k = tokens();
    const rows = fleet.rows();
    const a = fleet.current(rows);
    const w = this.width || 1200;
    const wide = w >= 860;
    const restore = store.get(STORE.restore);
    const lost = list(restore?.pending).length + list(restore?.failed).length;
    const queued = queue.get()?.count ?? 0;
    const agentPart = w >= 560 ? this.agent(k, a, wide) : [];
    return ViewRoot("lz-status", { bg: k.bg.app })
      .flex_row()
      .items_center()
      .px(10)
      .gap(6)
      .text_size(k.fontSize.sm)
      .line_height(`${k.lineHeight.sm}px`)
      .text_color(k.text.secondary)
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) < 1) return;
        this.width = size.width;
        cx.notify();
      })
      .child(h_flex().flex_none().gap(wide ? 8 : 2).items_center().children(this.stages(k, rows, wide)))
      .when(agentPart.length > 0, (e) => e.child(Divider({ vertical: true }).mx(6)).child(h_flex().min_w(0).gap(4).items_center().children(agentPart)))
      .child(Spacer())
      .when(lost > 0, (e) =>
        e.child(
          this.item(k, "st-restore", [Icon("rotate-ccw", { size: 13, color: k.state.info }), div().child(wide ? t("shell.status.restore", { count: lost }) : String(lost)), wide ? Kbd("⌥⌘R") : null].filter(Boolean), {
            tooltip: t("shell.status.restoreHint"),
            onClick: () => run("lazuli.resume"),
          }),
        ),
      )
      .child(
        this.item(k, "st-queue", [Icon("send", { size: 13 }), wide ? div().child(t("shell.status.queued")) : null, this.num(k, queued), Kbd("⌥⌘Q")].filter(Boolean), {
          tooltip: t("shell.status.queueHint"),
          onClick: () => queue.open(null),
        }),
      );
  }
}
