// The activity rail at the right edge of the main area (DESIGN D3, mockup A): Review, Files, Changes and the call
// tree, visible on every center view. A click opens the panel on that tab (from Home, Inbox, To-do or Routines it
// switches the center to the work view first); clicking the tab the panel shows hides the panel (sys/bus.js
// togglePanelChild, the same as ⌘1–4). Badges: the call tree's running or failed subagents (sys/scan.js badge()),
// and for the other tabs whatever their views publish as shared `lazuli.badge.<tab>` = {count, tone}.

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { props, setShared, shared } from "herdr";
import { NODE } from "../sys/state.js";
import { activeChild, panelVisible, togglePanelChild } from "../sys/bus.js";
import * as scan from "../sys/scan.js";
import { t } from "../core/i18n.js";
import { tokens } from "../ui/tokens.js";
import { ViewRoot, IconButton } from "../ui/kit.js";

// The rail block is a card in the layout: the view lets its fill and rounded edge show.
const CLEAR = "#00000000";

const ITEMS = Object.freeze([
  { child: "review", icon: "git-pull-request", key: "⌘1" },
  { child: "files", icon: "folder", key: "⌘2" },
  { child: "changes", icon: "file-diff", key: "⌘3" },
  { child: "tree", icon: "workflow", key: "⌘4" },
]);

// Herdr's tab bar remembers the panel per space among shared("workspace.panels") (H/mods/tabs/main.js syncPanel):
// lazuli's own panels join the list while this layout shows, so a space keeps its Review or call tree.
const OWN_PANELS = Object.freeze(["review", "tree"]);
const PANELS_KEY = "workspace.panels";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

export default class Activity {
  constructor(name) {
    this.name = name;
  }

  init(p, _cx) {
    this.props = props() ?? p ?? {};
    this.preview = this.props.preview === true;
    if (this.preview) return;
    const have = shared(PANELS_KEY);
    const list = Array.isArray(have) ? have : ["files", "changes"];
    if (OWN_PANELS.some((x) => !list.includes(x))) setShared(PANELS_KEY, [...new Set([...list, ...OWN_PANELS])]);
  }

  async close() {
    if (this.preview) return;
    const have = shared(PANELS_KEY);
    if (Array.isArray(have) && have.some((x) => OWN_PANELS.includes(x))) setShared(PANELS_KEY, have.filter((x) => !OWN_PANELS.includes(x)));
  }

  /** `{count, tone}` for a tab, or null. */
  badge(child) {
    if (child === "tree") {
      const b = scan.badge();
      return b ? { count: b.count, tone: b.tone === "destructive" ? "error" : "working" } : null;
    }
    const b = shared(`lazuli.badge.${child}`);
    return isObj(b) && typeof b.count === "number" && b.count > 0 ? b : null;
  }

  render(_cx) {
    const k = tokens();
    const shown = panelVisible() ? activeChild(this.props.stack ?? NODE.panelBody) : null;
    return ViewRoot("lz-activity", { bg: CLEAR })
      .items_center()
      .pt(8)
      .gap(4)
      .role("toolbar")
      .accessibility_label(t("shell.activity.label"))
      .children(
        ITEMS.map((item) => {
          const label = t(`shell.activity.${item.child}`);
          const on = shown === item.child;
          const b = this.badge(item.child);
          const button = IconButton(`act-${item.child}`, item.icon, label, {
            size: "lg",
            iconSize: 17,
            selected: on,
            tooltip: `${on ? t("shell.activity.hide", { name: label }) : label}  ${item.key}`,
            onClick: () => togglePanelChild(item.child),
          });
          if (!b) return button;
          const fill = k.state[b.tone] ?? k.accent;
          return div()
            .relative()
            .flex_none()
            .child(button)
            .child(
              h_flex()
                .absolute()
                .top(-2)
                .right(-3)
                .min_w(16)
                .h(16)
                .px(4)
                .items_center()
                .justify_center()
                .rounded(k.radius.full)
                .border(2)
                .border_color(k.bg.card)
                .bg(fill)
                .font_family(k.fonts.mono)
                .text_size(10)
                .font_weight(k.weight.bold)
                .text_color(k.text.onAccent)
                .accessibility_label(t("shell.activity.badge", { count: b.count }))
                .child(b.count > 99 ? "99+" : String(b.count)),
            );
        }),
      );
  }
}
