// What the chat block shows instead of a chat (K4 gates, D3, D5, D23, A2, A3): checking Hermes; no folder yet (the
// folder picker); the folder gone; Hermes missing (install and setup commands to copy, where lazuli looked, the
// tested version); `hermes acp --check` failing (its output and exit code); a relay device (desktop only). Every gate
// but the last two-line ones has its action: choose a folder, or check again.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { home } from "herdr";
import { t } from "../../core/i18n.js";
import { tokens, withAlpha } from "../../ui/tokens.js";
import { Text, Icon, IconButton, Button, Spinner } from "../../ui/kit.js";
import { LogBlock } from "../apps/ui.js";
import { tilde } from "../apps/fmt.js";

const INSTALL = "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash";
const SETUP = "hermes setup";
/** The Hermes version this screen was tested with (README, A14). */
export const TESTED_HERMES = "0.17.0";

/** The round glyph at the top of a gate, tinted for a warning or an error. */
function Disc(icon, tone) {
  const k = tokens();
  const color = tone === "warning" ? k.state.warning : tone === "error" ? k.state.error : k.text.tertiary;
  return div()
    .size(36)
    .flex_none()
    .flex()
    .items_center()
    .justify_center()
    .rounded(k.radius.full)
    .bg(k.bg.raised)
    .border_1()
    .border_color(tone ? withAlpha(color, 0.4) : k.line.soft)
    .child(Icon(icon, { size: k.icon.md, color }));
}

/** A command to run in a terminal, with Copy. */
function CommandLine(view, id, command) {
  const k = tokens();
  return h_flex()
    .id(id)
    .w_full()
    .min_w(0)
    .pl(10)
    .pr(4)
    .py(4)
    .gap(8)
    .items_center()
    .rounded(k.radius.md)
    .bg(k.bg.surface)
    .border_1()
    .border_color(k.line.soft)
    .child(Text(command, { size: "sm", mono: true, truncate: true }).flex_1())
    .child(IconButton(`${id}-copy`, "copy", t("assistant.gate.copy"), { onClick: (_e, cx) => view.copy(cx, command) }).size(k.control.sm));
}

/** The gate for `state.gate` (anything but "ok"), centered in the chat block. */
export function Gate(view, state) {
  const k = tokens();
  const g = state.gate;
  const d = state.gateDetail ?? {};
  const parts = [];
  let role = "alert";
  const actions = (...buttons) => h_flex().gap(6).mt(4).children(buttons);
  const title = (key) => Text(t(key), { size: "lg", weight: "semibold" }).mt(2);
  const body = (key, vars) => Text(t(key, vars), { tone: "secondary" });
  const recheck = (primary) => Button("ag-recheck", t("assistant.gate.retry"), { variant: primary ? "primary" : "secondary", icon: "refresh-cw", disabled: view.mode.preview, onClick: (_e, cx) => view.recheck(cx) });
  const choose = (key) => Button("ag-choose", t(key), { variant: "primary", icon: "folder-open", disabled: view.mode.preview, onClick: (_e, cx) => view.pickFolder(cx) });
  if (g === "checking") {
    return h_flex()
      .flex_1()
      .gap(8)
      .items_center()
      .justify_center()
      .role("status")
      .child(Spinner({ size: 14 }))
      .child(Text(t("assistant.gate.checking"), { size: "sm", tone: "secondary" }));
  }
  if (g === "no-folder") {
    role = "status";
    parts.push(Disc("folder-open"), title("assistant.gate.noFolder.title"), body("assistant.gate.noFolder.body"), actions(choose("assistant.gate.noFolder.action")), Text(t("assistant.gate.noFolder.hint"), { size: "sm", tone: "tertiary" }));
  } else if (g === "folder-missing") {
    parts.push(
      Disc("folder-x", "warning"),
      title("assistant.gate.missing.title"),
      ...(state.folder ? [div().px(8).py(4).rounded(k.radius.sm).bg(k.bg.surface).border_1().border_color(k.line.soft).child(Text(tilde(state.folder, home()), { size: "sm", mono: true }))] : []),
      body("assistant.gate.missing.body"),
      actions(recheck(false), choose("assistant.gate.missing.choose")),
    );
  } else if (g === "hermes-missing") {
    const looked = Array.isArray(d.looked) ? d.looked.map((p) => tilde(p, home())).join(", ") : null;
    parts.push(
      Disc("bot", "warning"),
      title("assistant.gate.hermes.title"),
      body("assistant.gate.hermes.body"),
      v_flex().w_full().gap(4).child(Text(t("assistant.gate.hermes.install"), { size: "xs", tone: "tertiary", weight: "medium" })).child(CommandLine(view, "ag-install", INSTALL)),
      v_flex().w_full().gap(4).child(Text(t("assistant.gate.hermes.setup"), { size: "xs", tone: "tertiary", weight: "medium" })).child(CommandLine(view, "ag-setup", SETUP)),
      actions(recheck(true)),
      Text([looked ? t("assistant.gate.hermes.looked", { where: looked }) : null, t("assistant.gate.hermes.tested", { version: TESTED_HERMES })].filter(Boolean).join(" · "), { size: "xs", tone: "tertiary" }),
    );
  } else if (g === "hermes-check-failed") {
    const output = typeof d.output === "string" && d.output ? d.output : typeof d.detail === "string" ? d.detail : "";
    parts.push(
      Disc("triangle-alert", "error"),
      title("assistant.gate.check.title"),
      body("assistant.gate.check.body"),
      ...(output
        ? [v_flex().w_full().gap(4).child(Text(t("assistant.gate.check.output", { code: d.code ?? "?" }), { size: "xs", tone: "tertiary", weight: "medium" })).child(LogBlock("ag-output", output.split("\n"), { maxHeight: 200, tone: "primary" }))]
        : []),
      Text(t("assistant.gate.check.hint"), { size: "sm", tone: "tertiary" }),
      actions(recheck(true)),
    );
  } else {
    role = "status";
    parts.push(Disc("laptop"), title("assistant.gate.relay.title"), body("assistant.gate.relay.body"));
  }
  return div()
    .id("ag-gate")
    .flex_1()
    .min_h(0)
    .flex()
    .items_center()
    .justify_center()
    .p(24)
    .overflow_y_scrollbar()
    .child(v_flex().w_full().max_w(480).items_start().gap(10).role(role).children(parts));
}
