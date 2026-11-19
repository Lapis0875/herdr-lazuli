// The bell at the right end of the top bar (mockup A): how many agents wait for the person, as a pyrite count on the
// bell. A click goes to the one that has waited longest (else the oldest finished one); a right-click lists every
// waiting and finished agent to pick from. Reference: lstack-herdr-cockpit's `bell.js` (removed; git history ee5201a).

import { h_flex } from "gpui-base";
import { props } from "herdr";
import * as fleet from "../sys/fleet.js";
import { t } from "../core/i18n.js";
import { tokens } from "../ui/tokens.js";
import { ViewRoot, IconButton } from "../ui/kit.js";
import { act, openMenu } from "./shell/actions.js";
import { agentName, dur, waitingFirst } from "./shell/format.js";

const num = (v) => typeof v === "number" && Number.isFinite(v);

export default class Bell {
  constructor(name) {
    this.name = name;
  }

  init(p, _cx) {
    this.props = props() ?? p ?? {};
    this.preview = this.props.preview === true;
  }

  /** Waiting agents (longest first), then the ones that finished unseen (oldest first). */
  lists(now = Date.now()) {
    const rows = fleet.rows(now);
    const waiting = waitingFirst(rows, now);
    const done = rows
      .filter((a) => a.status === "done" && a.stage !== "needs")
      .sort((x, y) => (num(x.since) ? x.since : now) - (num(y.since) ? y.since : now));
    return { waiting, done };
  }

  menu() {
    const now = Date.now();
    const { waiting, done } = this.lists(now);
    const row = (a, icon) => ({ label: agentName(a), detail: num(a.since) ? dur(now - a.since) : a.space_name, icon, action: { kind: "go", address: a.address } });
    const items = [];
    if (waiting.length) items.push({ heading: t("shell.bell.waiting", { count: waiting.length }) }, ...waiting.slice(0, 12).map((a) => row(a, "hand")));
    if (done.length) items.push(...(items.length ? [{ separator: true }] : []), { heading: t("shell.bell.done", { count: done.length }) }, ...done.slice(0, 8).map((a) => row(a, "circle-check")));
    if (!items.length) items.push({ label: t("shell.bell.nothing"), icon: "bell", disabled: true, action: null });
    openMenu(items, { width: 300, label: t("shell.bell.label") });
  }

  click() {
    const { waiting, done } = this.lists();
    const first = waiting[0] ?? done[0];
    if (first) act({ kind: "go", address: first.address });
    else this.menu();
  }

  render(_cx) {
    const k = tokens();
    const { waiting, done } = this.lists();
    const n = waiting.length;
    const label = n ? t("shell.bell.count", { count: n }) : done.length ? t("shell.bell.doneCount", { count: done.length }) : t("shell.bell.nothing");
    const tooltip = n || done.length ? `${label} · ${t("shell.bell.hint")}` : label;
    const bell = IconButton("lz-bell", n ? "bell-dot" : "bell", label, { iconSize: 17, count: n || undefined, tooltip, onClick: () => !this.preview && this.click() })
      .when(n > 0, (e) => e.text_color(k.state.blocked))
      .on_mouse_down("right", (_e, cx) => {
        cx.stop_propagation();
        if (!this.preview) this.menu();
      });
    return ViewRoot("lz-bell-root", { bg: k.bg.app }).child(h_flex().size_full().items_center().justify_center().child(bell));
  }
}
