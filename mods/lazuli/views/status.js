// The status bar under the main area (mockup A): the agents by stage (each count goes somewhere), the focused agent's
// program, PR and CI with ⌘G, its ticket with ⌘L, then terminals waiting to be restored (⌥⌘R), the queued prompts
// (⌥⌘Q), the herdr-relay chip on the Mac once herdr-relay is set up there (sys/relay.js) and, when herdr-caffeinate is
// installed, its chip (DESIGN D3). Its layout copy is the owner of the window-wide commands (sys/bus.js routes them to
// the view named "status") and runs the services (views/shell/services.js); a `preview: true` copy only draws.

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { props, run } from "herdr";
import * as store from "../sys/store.js";
import * as fleet from "../sys/fleet.js";
import * as queue from "../sys/queue.js";
import * as scan from "../sys/scan.js";
import * as caffeinate from "../sys/caffeinate.js";
import * as relay from "../sys/relay.js";
import { STORE } from "../sys/state.js";
import { showCenter } from "../sys/bus.js";
import { treeCommand } from "./panels/tree-actions.js";
import { t } from "../core/i18n.js";
import { MOD as CAFFEINATE } from "../core/caffeinate-chip.js";
import { labelKey as relayLabelKey, tipKey as relayTipKey, whyKey as relayWhyKey } from "../core/relay-chip.js";
import { tokens } from "../ui/tokens.js";
import { ViewRoot, Icon, Kbd, StatusDot, ProgramIcon, Spinner, Divider, Spacer, withTooltip, toneColor } from "../ui/kit.js";
import { startServices, stopServices } from "./shell/services.js";
import { act, openMenu } from "./shell/actions.js";
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

/** The caffeinate chip's time left, `{h, m}` → "1h 5m" / "42m"; null without one. */
function caffeinateLeft(left) {
  if (!left) return null;
  if (!left.h) return t("shell.caffeinate.left.m", { m: left.m });
  return left.m ? t("shell.caffeinate.left.hm", { h: left.h, m: left.m }) : t("shell.caffeinate.left.h", { h: left.h });
}

/** The caffeinate chip's words: the minutes left of a timer, a label while it keeps the Mac awake or waits for agents,
 *  none while off or starting (the tooltip says those). */
function caffeinateLabel(c) {
  if (c.status === "timer") return caffeinateLeft(c.left) ?? t("shell.caffeinate.label.timer");
  return c.status === "starting" || c.status === "off" ? null : t(`shell.caffeinate.label.${c.status}`);
}

/** The caffeinate chip's tooltip (also its accessibility label): the state, the display, the closed-lid state, the
 *  click. */
function caffeinateTip(c) {
  const left = caffeinateLeft(c.left);
  const parts = [c.status === "timer" ? (left ? t("shell.caffeinate.tip.timer", { left }) : t("shell.caffeinate.tip.timerOpen")) : t(`shell.caffeinate.tip.${c.status}`)];
  if (c.display) parts.push(t("shell.caffeinate.tip.display"));
  if (c.lid) parts.push(c.lid.blocked ? t("shell.caffeinate.tip.lid.blocked", { reason: t(`shell.caffeinate.blocked.${c.lid.blocked}`) }) : t(`shell.caffeinate.tip.lid.${c.lid.status}`));
  parts.push(t("shell.caffeinate.tip.open"));
  return parts.join(" · ");
}

/** Why a relay action failed (core whyKey): the program's own last line, or lazuli's words for a timeout or a save. */
function relayWhy(error) {
  return t(relayWhyKey(error), { detail: error.detail ?? "", s: error.seconds ?? "" });
}

/** The relay chip's tooltip (also its accessibility label): the state (with the failure's or the unknown status's
 *  reason), that autostart is on while the bridge is off, the click. */
function relayTip(c) {
  const parts = [t(relayTipKey(c), { reason: c.status === "error" ? relayWhy(c.error) : (c.reason ?? "") })];
  if (c.status === "off" && c.autostart) parts.push(t("shell.relay.tip.autostart"));
  parts.push(t("shell.relay.tip.open"));
  return parts.join(" · ");
}

/** The relay chip's menu: the state, the failure, the action it offers (core `actions`), what to do where lazuli
 *  offers nothing, and a fresh read. Items run `lazuli.relay:<verb>` through the command bus. */
function relayMenu(c) {
  const verbAction = (verb) => ({ kind: "run", run: `lazuli.relay:${verb}` });
  const items = [{ heading: t("shell.relay.menu.heading", { state: t(`shell.relay.state.${c.status}`) }) }];
  if (c.status === "error") items.push({ label: relayWhy(c.error), icon: "triangle-alert", disabled: true, action: null });
  for (const verb of c.actions) items.push({ label: t(`shell.relay.menu.${verb}`), icon: verb === "on" ? "play" : "circle-stop", action: verbAction(verb) });
  if (c.status === "unset") items.push({ label: t("shell.relay.menu.setup"), icon: "terminal", disabled: true, action: null });
  if (c.status === "external") items.push({ label: t("shell.relay.menu.external"), icon: "info", disabled: true, action: null });
  items.push({ separator: true }, { label: t("shell.relay.menu.refresh"), icon: "refresh-cw", action: verbAction("status") });
  if (c.status === "error") items.push({ label: t("shell.relay.menu.log"), icon: "scroll-text", action: { kind: "open", url: relay.logPath() } });
  openMenu(items, { width: 300, label: t("shell.relay.menu.label") });
}

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

  /** herdr-caffeinate's chip (sys/caffeinate.js), drawn only while that mod is installed: the coffee in its status's
   *  tone, its words, the closed-lid mark; a click opens that mod's menu. */
  caffeinateChip(k, c) {
    const color = toneColor(c.tone, k);
    const label = caffeinateLabel(c);
    const tip = caffeinateTip(c);
    const parts = [
      Icon(c.icon, { size: 13, color }),
      label ? div().text_color(color).when(c.status === "timer", (e) => e.font_family(k.fonts.mono)).child(label) : null,
      c.lid ? Icon(c.lid.icon, { size: 12, color: toneColor(c.lid.tone, k) }) : null,
    ];
    return this.item(k, "st-caffeinate", parts.filter(Boolean), { tooltip: tip, onClick: () => run(`${CAFFEINATE}.menu`) }).accessibility_label(tip);
  }

  /** herdr-relay's chip (sys/relay.js), drawn on the Mac once herdr-relay is set up there: the devices glyph in its
   *  status's tone (a spinner while it turns on or off, a warning after a failure), its words when the bar is wide;
   *  a click opens its menu. */
  relayChip(k, c, wide) {
    const color = toneColor(c.tone, k);
    const key = wide ? relayLabelKey(c) : null;
    const tip = relayTip(c);
    const parts = [c.busy ? Spinner({ size: 13, color }) : Icon(c.icon, { size: 13, color }), key ? div().text_color(color).child(t(key)) : null];
    return this.item(k, "st-relay", parts.filter(Boolean), { tooltip: tip, onClick: () => relayMenu(c) }).accessibility_label(tip);
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
    const cf = caffeinate.view(Date.now());
    const rl = relay.view();
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
      )
      .when(Boolean(rl), (e) => e.child(this.relayChip(k, rl, wide)))
      .when(Boolean(cf), (e) => e.child(this.caffeinateChip(k, cf)));
  }
}
