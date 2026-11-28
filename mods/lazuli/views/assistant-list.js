// The Assistant's chat list (`view: "assistant-list"`, block assistant-list, K2; A4, D13): chats grouped by Hermes
// profile, `default` first, a disabled "Nod · Planned" group last, the new-chat profile picker in the header. Before
// a folder and Hermes are ready (or on a relay device) it holds a quiet note and the picker is off.
//
// Data: the service (sys/assistant.js, K4) read through snapshot() in render and called inside cx.spawn; preview
// copies draw views/assistant/sample.js. A failed call shows its error for a few seconds under the header.
// Commands (K7, this copy acts on them): `lazuli.assistant:new[:<profile>]`, `lazuli.assistant:select:<profile>/<id>`;
// every copy takes `lazuli.assistant:sample:<name>`. A copy with `props.sample` or `props.preview` only draws.

import { props } from "herdr";
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { t } from "../core/i18n.js";
import { tokens } from "../ui/tokens.js";
import { ViewRoot, Text } from "../ui/kit.js";
import { Notice } from "./apps/ui.js";
import { probeHost, hostLocal } from "./apps/snapshot.js";
import { blockShown } from "./panels/common.js";
import * as sample from "./assistant/sample.js";
import { BLOCK, copyMode, callsOf, viewState, open, verbOf, sampleVerb, errorText } from "./assistant/common.js";
import { Group, PlannedGroup, NewChatPicker } from "./assistant/list-parts.js";

const HOST_MS = 2000;
const CLOCK_MS = 30000;

export default class AssistantList {
  constructor(name) {
    this.name = name;
  }

  init(p, cx) {
    this.props = props() ?? p ?? {};
    this.mode = copyMode(this.props);
    this.svc = callsOf(this.mode);
    this.hover = null;
    this.picker = false;
    this.notice = new Notice();
    this.seen = -1;
    if (this.mode.preview) return;
    probeHost(cx);
    cx.timer.every(HOST_MS, (cx) => {
      if (!hostLocal()) probeHost(cx);
    });
    // Row times ("12m") move on while the list is on screen.
    cx.timer.every(CLOCK_MS, (cx) => {
      if (blockShown(BLOCK.list)) cx.notify();
    });
  }

  /** Runs one service call and redraws when it settles; its error shows for a few seconds. A drawing-only copy acts
   *  on nothing. */
  act(cx, call) {
    if (this.mode.preview) return;
    cx.spawn(async (cx) => {
      const r = await call(cx);
      if (r?.error) this.notice.show(cx, { tone: "error", text: errorText(r.error) });
      cx.notify();
    });
  }

  select(cx, key) {
    this.act(cx, (cx) => this.svc.select(cx, key));
  }

  newSession(cx, profile) {
    this.picker = false;
    this.act(cx, (cx) => this.svc.newSession(cx, profile));
  }

  fork(cx, key) {
    this.act(cx, (cx) => this.svc.fork(cx, key));
  }

  retryBridge(cx, profile) {
    this.act(cx, (cx) => this.svc.retryBridge(cx, profile));
  }

  toggleGroup(cx, profile) {
    if (this.mode.preview) return;
    this.svc.toggleGroup(profile);
    cx.notify();
  }

  command(command, cx) {
    const v = verbOf(command);
    if (!v || sampleVerb(v, cx) || this.mode.preview) return;
    if (v.verb === "new") this.newSession(cx, v.arg || "default");
    else if (v.verb === "select" && v.arg) this.select(cx, v.arg);
  }

  /** A preview copy takes the shown sample's seed when it changes: the open picker, a hovered row. */
  seed() {
    if (!this.mode.preview || sample.revision() === this.seen) return;
    this.seen = sample.revision();
    const s = sample.viewSeed(this.mode.pinned ?? undefined);
    this.picker = s.picker === true;
    this.hover = s.hover ?? null;
  }

  render(_cx) {
    this.seed();
    const k = tokens();
    const now = Date.now();
    const s = viewState(this.mode);
    const shows = open(s);
    const head = h_flex()
      .h(40)
      .flex_none()
      .pl(12)
      .pr(6)
      .gap(2)
      .items_center()
      .border_b_1()
      .border_color(k.line.soft)
      .child(Text(t("assistant.list.title"), { size: "sm", weight: "semibold", nowrap: true }).flex_1())
      .child(NewChatPicker(this, s, { disabled: !shows || this.mode.preview }));
    if (!shows) {
      const note = s.gate === "relay" ? t("assistant.gate.relay.short") : t("assistant.list.gated");
      const box = div()
        .m(8)
        .min_h(38)
        .px(10)
        .py(8)
        .flex()
        .items_center()
        .justify_center()
        .rounded(k.radius.lg)
        .border_1()
        .border_dashed()
        .border_color(k.line.soft)
        .child(Text(note, { size: "sm", tone: "tertiary" }).text_center());
      return ViewRoot("al-root", { bg: k.bg.card }).child(head).child(box);
    }
    const rows = [];
    (s.list.groups ?? [])
      .filter((g) => g.visible !== false)
      .forEach((g, i) => {
        if (i > 0) rows.push(div().h(6).flex_none());
        rows.push(...Group(this, s, g, now));
      });
    rows.push(...(s.list.planned ?? []).map((pl) => PlannedGroup(pl)));
    const body = v_flex()
      .id("al-body")
      .flex_1()
      .min_h(0)
      .overflow_y_scrollbar()
      .px(6)
      .py(6)
      .gap(1)
      .role("list")
      .accessibility_label(t("assistant.list.label"))
      .children(rows);
    const banner = this.notice.render("al-notice", t("common.close"));
    return ViewRoot("al-root", { bg: k.bg.card })
      .relative()
      .child(head)
      .child(body)
      .when(Boolean(banner), (e) => e.child(h_flex().absolute().left(8).right(8).top(46).child(banner)));
  }
}
