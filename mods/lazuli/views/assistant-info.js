// The Assistant's session info (`view: "assistant-info"`, block assistant-info above the files, K2, K8, A10): the
// selected chat's model and mode (session state; the mode is read-only, D31), context used of its size
// (`usage_update`), the last reply's tokens (`PromptResponse.usage`), and from Hermes's database the totals with API
// calls and the cost with its status ("unknown" when absent). Six 20 px rows that fit the block's 188 px.
//
// Data: the service's state (sys/assistant.js snapshot(), K4, through common.js viewState); preview copies draw
// views/assistant/sample.js. A copy with `props.sample` or `props.preview` only draws.

import { props } from "herdr";
import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { t } from "../core/i18n.js";
import { tokens } from "../ui/tokens.js";
import { ViewRoot, Text } from "../ui/kit.js";
import { Bar } from "./apps/ui.js";
import { money, tokensText } from "./apps/fmt.js";
import { probeHost, hostLocal } from "./apps/snapshot.js";
import { copyMode, viewState, open, verbOf, sampleVerb } from "./assistant/common.js";
import { selectedRow, selectedChat, currentModel, currentMode, usageOf } from "./assistant/model.js";

const HOST_MS = 2000;
const LABEL_W = 72;
/** Tokens as "42.1k", "272k", "410": the shared short form without a trailing ".0". */
const shortTokens = (n) => tokensText(n).replace(/\.0(?=[kM]$)/, "");

export default class AssistantInfo {
  constructor(name) {
    this.name = name;
  }

  init(p, cx) {
    this.props = props() ?? p ?? {};
    this.mode = copyMode(this.props);
    if (this.mode.preview) return;
    probeHost(cx);
    cx.timer.every(HOST_MS, (cx) => {
      if (!hostLocal()) probeHost(cx);
    });
  }

  command(command, cx) {
    sampleVerb(verbOf(command), cx);
  }

  render(_cx) {
    const k = tokens();
    const s = viewState(this.mode);
    const chat = open(s) ? selectedChat(s) : null;
    const head = h_flex()
      .h(40)
      .flex_none()
      .px(12)
      .items_center()
      .border_b_1()
      .border_color(k.line.soft)
      .child(Text(t("assistant.info.title"), { size: "sm", weight: "semibold", nowrap: true }));
    const root = ViewRoot("ai-root", { bg: k.bg.card }).accessibility_label(t("assistant.info.title")).child(head);
    if (!chat) {
      const note = s.gate === "relay" ? t("assistant.gate.relay.short") : t("assistant.info.noSession");
      return root.child(div().flex_1().flex().items_center().justify_center().p(12).child(Text(note, { size: "sm", tone: "tertiary" }).text_center()));
    }
    const u = usageOf(chat, selectedRow(s)?.row);
    // Elements are single-use: each row gets its own "—" and "unknown" (an older chat or a fork lacks several values).
    const none = () => Text(t("assistant.info.none"), { size: "sm", tone: "tertiary", nowrap: true });
    const unknown = () => Text(t("assistant.info.unknown"), { size: "sm", tone: "tertiary", nowrap: true });
    const mono = (text) => Text(text, { size: "xs", mono: true, truncate: true });
    const row = (label, ...value) =>
      h_flex()
        .h(20)
        .flex_none()
        .gap(8)
        .items_center()
        .min_w(0)
        .child(Text(t(label), { size: "sm", tone: "tertiary", nowrap: true }).w(LABEL_W).flex_none())
        .child(h_flex().flex_1().min_w(0).gap(8).items_center().children(value));
    const model = currentModel(chat);
    const mode = currentMode(chat);
    const cost = u.cost;
    return root.child(
      v_flex()
        .flex_1()
        .min_h(0)
        .px(12)
        .py(8)
        .gap(2)
        .child(row("assistant.info.model", model ? mono(model.name) : none()))
        .child(row("assistant.info.mode", mode ? mono(mode) : none()))
        .child(
          row(
            "assistant.info.context",
            ...(u.context
              ? [mono(t("assistant.info.contextValue", { used: shortTokens(u.context.used), size: shortTokens(u.context.size) })).flex_shrink_1(), div().w(56).flex_none().accessibility_label(`${Math.round(u.context.ratio * 100)}%`).child(Bar(u.context.ratio))]
              : [none()]),
          ),
        )
        .child(row("assistant.info.lastTurn", u.lastTurn ? mono(t("assistant.info.lastTurnValue", { input: shortTokens(u.lastTurn.input), output: shortTokens(u.lastTurn.output) })) : none()))
        .child(row("assistant.info.total", u.totals ? mono(t("assistant.info.totalValue", { tokens: shortTokens(u.totals.tokens), calls: u.totals.calls })) : none()))
        .child(
          row(
            "assistant.info.cost",
            ...(!cost || cost.usd === null || cost.usd === undefined
              ? [unknown()]
              : [mono(money(cost.usd)).flex_none(), Text(t(`assistant.info.costStatus.${["actual", "estimated", "included"].includes(cost.status) ? cost.status : "unknown"}`), { size: "sm", tone: "tertiary", nowrap: true })]),
          ),
        ),
    );
  }
}
