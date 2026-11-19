// A context menu, opened at the pointer by views/shell/actions.js openMenu() (`kind: "popup"`, `frame: "none"`): the
// sidebar's agents, tabs, spaces and pinned apps, the bell's list, the pane header's overflow. `props().items` are
// `[{label, icon?, detail?, kbd?, danger?, disabled?, checked?, action}]`, `{separator: true}` or `{heading}`; a chosen
// item runs its action descriptor (shell/actions.js perform) and the menu closes. ↑/↓ move, Enter runs, Esc closes.

import { closeOverlay, props } from "herdr";
import { tokens } from "../ui/tokens.js";
import { Menu, MenuItem, MenuLabel, MenuSeparator } from "../ui/kit.js";
import { perform } from "./shell/actions.js";

const log = (msg) => console.log(`[lazuli/menu] ${msg}`);
const errText = (e) => e?.message ?? String(e);
const pickable = (item) => Boolean(item) && !item.separator && !item.heading && !item.disabled;

export default class MenuView {
  constructor(name) {
    this.name = name;
  }

  init(p, cx) {
    this.props = props() ?? p ?? {};
    this.at = -1;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  items() {
    const v = props()?.items;
    return Array.isArray(v) ? v.filter(Boolean) : [];
  }

  dismiss() {
    const id = props()?.overlay;
    if (id) closeOverlay(id);
  }

  /** Runs the item: its action starts first (an `exec` it starts outlives this copy), then the menu closes. */
  choose(item) {
    if (!pickable(item) || props()?.preview === true) return;
    perform(item.action).then(undefined, (e) => log(`${item.action?.kind} failed: ${errText(e)}`));
    this.dismiss();
  }

  /** A key from the window or the `key:` test hook: true when the menu used it. */
  key(e, _cx) {
    const items = this.items();
    const order = items.map((item, i) => (pickable(item) ? i : -1)).filter((i) => i >= 0);
    if (!order.length && e.key !== "escape") return false;
    const pos = order.indexOf(this.at);
    if (e.key === "escape") this.dismiss();
    else if (e.key === "down") this.at = order[pos < 0 ? 0 : Math.min(pos + 1, order.length - 1)];
    else if (e.key === "up") this.at = order[pos < 0 ? order.length - 1 : Math.max(pos - 1, 0)];
    else if (e.key === "home") this.at = order[0];
    else if (e.key === "end") this.at = order[order.length - 1];
    else if (e.key === "enter" || e.key === "space") this.choose(items[this.at]);
    else return false;
    return true;
  }

  render(_cx) {
    const k = tokens();
    const items = this.items();
    return Menu({ id: "lz-menu", width: props()?.width ?? 240, label: props()?.label })
      .w_full()
      .h_full()
      .overflow_hidden()
      .text_color(k.text.primary)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (!this.key(e, cx)) return;
        cx.stop_propagation();
        cx.notify();
      })
      .children(
        items.map((item, i) => {
          if (item.separator) return MenuSeparator();
          if (item.heading) return MenuLabel(String(item.heading));
          return MenuItem(`menu-${i}`, {
            label: String(item.label ?? ""),
            icon: item.icon,
            detail: item.detail,
            kbd: item.kbd,
            danger: item.danger === true,
            checked: item.checked === true,
            disabled: item.disabled === true,
            selected: i === this.at,
            onClick: () => this.choose(item),
          });
        }),
      );
  }
}
