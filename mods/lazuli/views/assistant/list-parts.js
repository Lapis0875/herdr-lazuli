// The list's parts (assistant-list, K6 ListModel, A4): a profile group's header (twisty, name, chat count, running
// count, bridge dot, "+"), its bridge error line with Retry, its chat rows (running spinner or "Needs you", time, Fork
// on hover), the disabled "Nod · Planned" group, and the new-chat profile picker with Nod Planned (AT-14).

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { t } from "../../core/i18n.js";
import { tokens } from "../../ui/tokens.js";
import { Text, Icon, IconButton, Button, Spinner, Row, Badge, Menu, MenuItem, MenuLabel, MenuSeparator, Spacer, Kbd } from "../../ui/kit.js";
import { stopPress } from "../panels/common.js";
import { BridgeDot, rowTime, bannerCode } from "./common.js";
import { waitsForYou } from "./model.js";
import { MenuIconButton, MenuPopover } from "./menu.js";

const PICKER_ROWS = 9;

/** One profile group: header, error line, rows (none when collapsed, A4). */
export function Group(view, state, g, now) {
  const k = tokens();
  const count = g.rows.length;
  const twisty = IconButton(`al-tw-${g.profile}`, g.collapsed ? "chevron-right" : "chevron-down", t(g.collapsed ? "assistant.list.expand" : "assistant.list.collapse", { profile: g.profile }), {
    iconSize: 12,
    onClick: (_e, cx) => view.toggleGroup(cx, g.profile),
  })
    .size(20)
    .rounded(k.radius.sm);
  const head = h_flex()
    .id(`al-g-${g.profile}`)
    .flex_none()
    .h(k.row.md)
    .pl(2)
    .gap(6)
    .items_center()
    .role("heading")
    .child(twisty)
    .child(Text(g.profile, { size: "sm", weight: "semibold", truncate: true }).flex_shrink_1())
    .child(Text(g.agent ?? "hermes", { size: "xs", tone: "tertiary", mono: true, nowrap: true }))
    .child(div().flex_none().accessibility_label(t("assistant.list.count", { count })).child(Text(String(count), { size: "xs", tone: "tertiary", mono: true })))
    .child(Spacer())
    .when(g.running > 0, (e) =>
      e.child(
        h_flex()
          .flex_none()
          .gap(3)
          .items_center()
          .accessibility_label(t("assistant.list.running", { count: g.running }))
          .tooltip(t("assistant.list.running", { count: g.running }))
          .child(Spinner({ size: 12 }))
          .child(Text(String(g.running), { size: "xs", tone: "working", mono: true })),
      ),
    )
    .child(BridgeDot(`al-dot-${g.profile}`, g.bridge))
    .child(stopPress(IconButton(`al-new-${g.profile}`, "plus", t("assistant.list.newIn", { profile: g.profile }), { size: "md", onClick: (_e, cx) => view.newSession(cx, g.profile) }).size(k.control.sm)));
  const out = [head];
  if (g.bridge === "error") {
    const code = bannerCode(state.bridges?.[g.profile]?.error);
    out.push(
      h_flex()
        .id(`al-err-${g.profile}`)
        .flex_none()
        .pl(28)
        .pr(4)
        .pb(4)
        .gap(6)
        .items_center()
        .role("alert")
        .child(Icon("circle-x", { size: 12, color: k.state.error }))
        .child(Text(t(`assistant.banner.${code}`), { size: "xs", tone: "error", truncate: true }).flex_shrink_1())
        .child(
          stopPress(Button(`al-retry-${g.profile}`, t("assistant.bridge.retry"), { variant: "ghost", size: "sm", onClick: (_e, cx) => view.retryBridge(cx, g.profile) }))
            .h(18)
            .px(4)
            .text_size(k.fontSize.xs)
            .text_color(k.accent),
        ),
    );
  }
  if (!g.collapsed) {
    for (const r of g.rows) out.push(SessionRow(view, state, r, now));
    // The group's own list could not be read (K6: a failing query with no bridge to ask instead).
    if (g.error && !count) out.push(Text(t("assistant.list.readFailed"), { size: "sm", tone: "error" }).pl(28).py(4).tooltip(g.error));
    else if (g.loading && !count) out.push(Text(t("common.loading"), { size: "sm", tone: "tertiary" }).pl(28).py(4));
    else if (!count) out.push(Text(t("assistant.list.empty"), { size: "sm", tone: "tertiary" }).pl(28).py(4));
  }
  return out;
}

/** A chat row: spinner while it runs, a pyrite hand and "Needs you" while an approval waits; Fork on hover. */
function SessionRow(view, state, r, now) {
  const k = tokens();
  const waiting = waitsForYou(state, r.key, now);
  const hovered = view.hover === r.key;
  const lead = div()
    .flex_none()
    .size(14)
    .flex()
    .items_center()
    .justify_center()
    .when(waiting, (e) => e.child(Icon("hand", { size: 13, color: k.state.blocked })))
    .when(!waiting && r.running, (e) => e.child(Spinner({ size: 13, label: t("assistant.list.running", { count: 1 }) })));
  const trailing = hovered
    ? [stopPress(IconButton(`al-fork-${r.key}`, "git-fork", t("assistant.list.fork"), { iconSize: 13, onClick: (_e, cx) => view.fork(cx, r.key) }).size(20).rounded(k.radius.sm))]
    : waiting
      ? [Text(t("assistant.list.needsYou"), { size: "xs", tone: "blocked", weight: "medium", nowrap: true })]
      : [Text(rowTime(r.updatedAt, now), { size: "xs", tone: "tertiary", mono: true, nowrap: true })];
  return Row(`al-r-${r.key}`, {
    label: r.title || t("assistant.list.untitled"),
    leading: lead,
    selected: r.selected,
    indent: 6,
    trailing,
    tone: r.title ? "secondary" : "tertiary",
    tooltip: r.title && r.title.length > 28 ? r.title : undefined,
    onClick: (_e, cx) => view.select(cx, r.key),
  })
    .tab_index(0)
    .focus((s) => s.bg(k.bg.hover))
    .on_key_down((e, cx) => {
      if (e.keystroke !== "enter" && e.keystroke !== "space") return;
      cx.stop_propagation();
      view.select(cx, r.key);
    })
    .on_hover((on, cx) => {
      const next = on ? r.key : view.hover === r.key ? null : view.hover;
      if (next === view.hover) return;
      view.hover = next;
      cx.notify();
    });
}

/** A planned agent's group (K6 `planned[]`: `{agent, name}`): its name and a Planned badge, disabled (D8). */
export function PlannedGroup(pl) {
  const k = tokens();
  const name = pl.name ?? pl.agent;
  return h_flex()
    .id(`al-planned-${pl.agent}`)
    .flex_none()
    .h(k.row.md)
    .mt(6)
    .pl(28)
    .gap(8)
    .items_center()
    .opacity(0.6)
    .accessibility_label(`${name} · ${t("assistant.group.planned")}`)
    .tooltip(t("assistant.group.plannedHint"))
    .child(Text(name, { size: "sm", weight: "semibold", nowrap: true }))
    .child(Badge(t("assistant.group.planned")));
}

/** The new-chat button and its profile picker: every Hermes profile (default first), then Nod disabled with Planned. */
export function NewChatPicker(view, state, { disabled = false } = {}) {
  const k = tokens();
  if (disabled) return IconButton("al-new", "message-square-plus", t("assistant.list.new"), { disabled: true });
  const profiles = state.list?.pickable?.length ? state.list.pickable : ["default"];
  const pick = (profile) => (_e, cx) => {
    view.picker = false;
    view.newSession(cx, profile);
  };
  // A closed picker builds no rows: only the trigger draws.
  return MenuPopover("al-picker", {
    trigger: MenuIconButton("al-new", "message-square-plus", t("assistant.list.new"), { open: view.picker }),
    open: view.picker,
    anchor: "top_right",
    onOpen: (open) => {
      view.picker = open;
    },
    menu: () => {
      const items = profiles.map((p) =>
        MenuItem(`al-pick-${p}`, { label: p, icon: p === "default" ? "bot" : "user", detail: p === "default" ? t("assistant.picker.default") : undefined, onClick: pick(p) }),
      );
      const planned = (state.list?.planned ?? []).map((pl) => MenuItem(`al-pick-${pl.agent}`, { label: pl.name ?? pl.agent, icon: "circle-dashed", detail: t("assistant.group.planned"), disabled: true }));
      return Menu({
        id: "al-picker-menu",
        width: 252,
        label: t("assistant.list.new"),
        children: [
          h_flex().child(MenuLabel(t("assistant.picker.label")).flex_1()).child(Kbd(String(profiles.length)).mr(8)),
          v_flex().id("al-picker-rows").max_h(k.row.md * PICKER_ROWS + PICKER_ROWS).overflow_y_scrollbar().gap(1).children(items),
          ...(planned.length ? [MenuSeparator(), MenuLabel(t("assistant.picker.other")), ...planned] : []),
        ],
      });
    },
  });
}
