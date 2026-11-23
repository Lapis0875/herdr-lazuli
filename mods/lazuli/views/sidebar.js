// The sidebar (mockup A, left column) between the brand row and the footer: the search field that opens the palette,
// the places (Home, Work, then the pinned apps from settings().pins with what waits in each), and the space tree
// (views/shell/spaces.js). Pinned apps reorder by drag and come out by right click. Folded below 160 px it draws a
// rail: the places as icons, the spaces as letter tiles.
//
// `props().footer === true` draws the sidebar's footer instead, in place of Herdr's workspace-chrome footer: lazuli's
// settings, Herdr's settings (with the update-ready dot), and Add machine.

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { props, run, setAgentOrder, spaces, updates, window as appWindow } from "herdr";
import * as store from "../sys/store.js";
import * as todo from "../sys/todo.js";
import { NODE, STORE } from "../sys/state.js";
import * as assistant from "../sys/assistant.js";
import { isRunning } from "../core/assistant-chat.js";
import { pendingPermissions } from "./assistant/model.js";
import { activeChild, showCenter } from "../sys/bus.js";
import { t } from "../core/i18n.js";
import { tokens } from "../ui/tokens.js";
import { ViewRoot, Text, Icon, IconButton, Kbd, Count, Row, SectionHeader, StatusDot, withTooltip } from "../ui/kit.js";
import { openMenu, openSettings, sidebarNarrow, togglePalette, toggleSidebar } from "./shell/actions.js";
import { pinItems } from "./shell/menus.js";
import { SpaceTree } from "./shell/spaces.js";

const list = (v) => (Array.isArray(v) ? v : []);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const stop = (_e, cx) => cx.stop_propagation();

/** The places: Home and Work always, then the pinnable apps. */
const PLACES = Object.freeze({
  home: { icon: "layout-dashboard", key: "⌥⌘0" },
  work: { icon: "columns", key: null },
  inbox: { icon: "inbox", key: "⌥⌘1" },
  todo: { icon: "list-todo", key: "⌥⌘2" },
  routines: { icon: "calendar-clock", key: "⌥⌘3" },
  assistant: { icon: "bot", key: "⌥⌘4" },
});
const APPS = Object.freeze(["inbox", "todo", "routines", "assistant"]);

/** What waits in an app: `{count, tone}` (a pill), `{dot}` (running or failed) or null. */
function badgeOf(app) {
  if (app === "inbox") {
    const gh = store.get(STORE.gh);
    const fails = (p) => p?.review === "CHANGES_REQUESTED" || p?.ci === "FAILURE" || p?.ci === "ERROR" || (typeof p?.threads === "number" && p.threads > 0) || p?.threadsPartial === true;
    const urgent = list(gh?.direct).length + list(gh?.mine).filter(fails).length;
    const count = urgent + list(gh?.team).length;
    return count ? { count, tone: urgent ? "wait" : "default", label: t("shell.nav.inboxCount", { count }) } : null;
  }
  if (app === "todo") {
    const open = todo.get()?.open;
    return typeof open === "number" && open > 0 ? { count: open, tone: "default", label: t("shell.nav.todoCount", { count: open }) } : null;
  }
  if (app === "routines") {
    const v = store.get(STORE.routines);
    if (isObj(v?.running) && Object.keys(v.running).length) return { dot: "working", label: t("shell.nav.routinesRunning") };
    const failed = list(v?.routines).filter((r) => r?.last && r.last.ok === false && !r.last.missed && !r.running).length;
    return failed ? { dot: "error", label: t("shell.nav.routinesFailed", { count: failed }) } : null;
  }
  if (app === "assistant") {
    // Approvals waiting first (a pyrite count, A6), else a turn running (the working dot); from the service's state.
    const sessions = Object.values(assistant.snapshot()?.sessions ?? {});
    const now = Date.now();
    const waiting = sessions.filter((c) => pendingPermissions(c, now).length > 0).length;
    const running = sessions.filter((c) => isRunning(c)).length;
    const label = t("shell.nav.assistant", { running, waiting });
    if (waiting) return { count: waiting, tone: "wait", label };
    return running ? { dot: "working", label } : null;
  }
  return null;
}

export default class Sidebar {
  constructor(name) {
    this.name = name;
  }

  init(p, _cx) {
    this.props = props() ?? p ?? {};
    this.preview = this.props.preview === true;
    this.footer = this.props.footer === true;
    this.tree = new SpaceTree();
    this.pinDrag = null;
  }

  /** The pins in their order, only the apps lazuli has. */
  pins() {
    return store.settings().pins.filter((p) => APPS.includes(p));
  }

  movePin(from, to) {
    const order = this.pins();
    if (!order.includes(from) || !order.includes(to) || from === to) return;
    const next = order.filter((p) => p !== from);
    next.splice(next.indexOf(to) + (order.indexOf(from) < order.indexOf(to) ? 1 : 0), 0, from);
    store.updateSettings((s) => ({ ...s, pins: [...next, ...s.pins.filter((p) => !APPS.includes(p))] }));
  }

  trailing(k, place) {
    if (place === "home") return [Kbd(PLACES.home.key)];
    const b = badgeOf(place);
    if (!b) return [];
    if (b.dot) {
      const color = b.dot === "error" ? k.state.error : k.state.working;
      return [div().flex_none().size(6).rounded(k.radius.full).bg(color).mr(5).accessibility_label(b.label).when(b.dot === "working", (e) => e.loop("opacity", { from: 0.45, to: 1, period: 1400 }))];
    }
    return [Count(b.count, { tone: b.tone, label: b.label })];
  }

  navRow(k, place, center) {
    const spec = PLACES[place];
    const label = t(`shell.app.${place}`);
    const pinned = APPS.includes(place);
    const d = this.pinDrag;
    let row = Row(`nav-${place}`, {
      icon: spec.icon,
      label,
      selected: center === place,
      trailing: this.trailing(k, place),
      tooltip: spec.key ? `${label}  ${spec.key}` : label,
      onClick: () => !this.preview && showCenter(place),
      onSecondaryClick: pinned
        ? (_e, cx) => {
            cx.stop_propagation();
            if (!this.preview) openMenu(pinItems(place, label));
          }
        : undefined,
    });
    if (!pinned) return row;
    row = row
      .relative()
      .when(Boolean(d && d.from === place && d.over !== place), (e) => e.opacity(0.5))
      .on_mouse_down("left", () => {
        this.pinDrag = { from: place, over: place };
      })
      .on_mouse_move((_e, cx) => {
        if (this.pinDrag && this.pinDrag.over !== place) {
          this.pinDrag.over = place;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const drag = this.pinDrag;
        this.pinDrag = null;
        if (drag && drag.from !== place && !this.preview) this.movePin(drag.from, place);
        cx.notify();
      });
    if (d && d.over === place && d.from !== place) {
      const after = this.pins().indexOf(d.from) < this.pins().indexOf(place);
      row = row.child(div().absolute().left(8).right(8).h(2).rounded(1).bg(k.accent).when(after, (l) => l.bottom(0)).when(!after, (l) => l.top(0)));
    }
    return row;
  }

  searchField(k) {
    return withTooltip(
      h_flex()
        .id("sb-search")
        .flex_none()
        .h(30)
        .mt(2)
        .mb(8)
        .px(8)
        .gap(8)
        .items_center()
        .rounded(k.radius.md)
        .border_1()
        .border_color(k.line.soft)
        .bg(k.bg.card)
        .text_size(k.fontSize.sm)
        .text_color(k.text.tertiary)
        .cursor_pointer()
        .role("search")
        .accessibility_label(t("shell.sidebar.search"))
        .hover((s) => s.border_color(k.line.strong))
        .on_click(() => !this.preview && togglePalette())
        .child(Icon("command", { size: 13 }))
        .child(div().flex_1().min_w(0).truncate().child(t("shell.sidebar.search")))
        .child(Kbd("⇧⌘P")),
      t("shell.sidebar.searchHint"),
    );
  }

  spacesHeader(k) {
    const sp = spaces() ?? [];
    const folded = this.tree.folded();
    const all = sp.length > 0 && sp.every((s) => folded.has(s.id));
    return SectionHeader({
      id: "sb-spaces",
      variant: "sidebar",
      title: t("shell.sidebar.spaces"),
      trailing: [
        IconButton("sb-fold-all", all ? "chevrons-up-down" : "chevrons-down-up", all ? t("shell.sidebar.unfoldAll") : t("shell.sidebar.foldAll"), {
          iconSize: 13,
          disabled: !sp.length,
          onClick: () => !this.preview && this.tree.setFolded(all ? new Set() : new Set(sp.map((s) => s.id))),
        }),
        IconButton("sb-new-space", "plus", t("shell.sidebar.newSpace"), { iconSize: 13, onClick: () => !this.preview && run("space.new") }),
      ],
    }).mt(14);
  }

  footerView(k, narrow) {
    const ready = Boolean(updates()?.app?.ready);
    const row = (id, icon, label, onClick, { dim = false, trailing = null, dot = false } = {}) =>
      withTooltip(
        h_flex()
          .id(id)
          .flex_none()
          .relative()
          .h(28)
          .gap(9)
          .items_center()
          .rounded(k.radius.md)
          .cursor_pointer()
          .text_color(dim ? k.text.tertiary : k.text.secondary)
          .role("button")
          .accessibility_label(label)
          .hover((s) => s.bg(k.bg.hover).text_color(k.text.primary))
          .on_click(() => !this.preview && onClick())
          .when(narrow, (e) => e.w(32).justify_center())
          .when(!narrow, (e) => e.px(8))
          .child(Icon(icon, { size: 14 }))
          .when(!narrow, (e) => e.child(div().flex_1().min_w(0).truncate().child(label)))
          .when(!narrow && Boolean(trailing), (e) => e.child(trailing))
          .when(narrow && dot, (e) => e.child(div().absolute().top(5).right(6).size(6).rounded(k.radius.full).bg(k.accent))),
        label,
      );
    const herdr = withTooltip(
      h_flex()
        .id("foot-herdr")
        .flex_none()
        .h(22)
        .px(6)
        .gap(5)
        .items_center()
        .rounded(k.radius.sm)
        .text_size(k.fontSize.xs)
        .text_color(k.text.tertiary)
        .cursor_pointer()
        .role("button")
        .accessibility_label(ready ? t("shell.footer.herdrUpdate") : t("shell.footer.herdr"))
        .hover((s) => s.bg(k.bg.selected).text_color(k.text.primary))
        .on_mouse_down("left", stop)
        .on_click((_e, cx) => {
          cx.stop_propagation();
          if (!this.preview) run("app.settings", ready ? { section: "updates" } : {});
        })
        .child(t("shell.footer.herdrShort"))
        .when(ready, (e) => e.child(div().size(6).rounded(k.radius.full).bg(k.accent))),
      ready ? t("shell.footer.herdrUpdate") : t("shell.footer.herdr"),
    );
    return ViewRoot("lz-sidebar-footer", { bg: k.bg.chrome })
      .border_t(1)
      .border_color(k.line.soft)
      .px(narrow ? 0 : 8)
      .pt(4)
      .pb(8)
      .when(narrow, (e) => e.items_center())
      .child(row("foot-settings", "settings", t("shell.footer.settings"), () => openSettings(), { trailing: herdr, dot: ready }))
      .child(row("foot-machine", "plus", t("shell.footer.addMachine"), () => run("mod.open", { name: "machine-add" }), { dim: true }));
  }

  railView(k, center) {
    const w = appWindow();
    const lights = w?.platform === "macos" && !w?.fullscreen;
    const places = ["home", "work", ...this.pins()];
    return ViewRoot("lz-sidebar", { bg: k.bg.chrome })
      .items_center()
      .py(6)
      .gap(2)
      .when(lights, (e) => e.child(IconButton("rail-unfold", "sidebar", t("shell.brand.unfold"), { onClick: () => !this.preview && toggleSidebar() })))
      .child(IconButton("rail-search", "search", t("shell.sidebar.search"), { tooltip: `${t("shell.sidebar.search")}  ⇧⌘P`, onClick: () => !this.preview && togglePalette() }))
      .children(
        places.map((place) => {
          const b = place === "home" ? null : badgeOf(place);
          const label = t(`shell.app.${place}`);
          return div()
            .relative()
            .flex_none()
            .child(IconButton(`rail-${place}`, PLACES[place].icon, label, { size: "lg", selected: center === place, tooltip: PLACES[place].key ? `${label}  ${PLACES[place].key}` : label, onClick: () => !this.preview && showCenter(place) }))
            .when(Boolean(b), (e) => e.child(div().absolute().top(4).right(4).size(7).rounded(k.radius.full).bg(b.dot === "error" ? k.state.error : b.dot === "working" ? k.state.working : b.tone === "wait" ? k.state.blocked : k.accent)));
        }),
      )
      .child(div().w(18).h(1).my(6).bg(k.line.soft))
      .child(
        v_flex()
          .id("rail-spaces")
          .flex_1()
          .min_h(0)
          .w_full()
          .items_center()
          .gap(4)
          .overflow_y_scrollbar()
          .children(
            (spaces() ?? []).map((s) =>
              withTooltip(
                h_flex()
                  .id(`rail-space-${s.id}`)
                  .flex_none()
                  .relative()
                  .size(28)
                  .items_center()
                  .justify_center()
                  .rounded(k.radius.md)
                  .cursor_pointer()
                  .bg(s.active && center === "work" ? k.bg.selected : k.bg.raised)
                  .border_1()
                  .border_color(k.line.soft)
                  .text_size(k.fontSize.sm)
                  .font_weight(k.weight.semibold)
                  .text_color(s.active ? k.text.primary : k.text.secondary)
                  .accessibility_label(s.name)
                  .hover((st) => st.border_color(k.line.strong))
                  .on_click(() => {
                    if (this.preview) return;
                    run("space.select", { id: s.id });
                    if (center !== "work") showCenter("work");
                  })
                  .child([...String(s.name ?? "?")][0]?.toUpperCase() ?? "?")
                  .when(s.status === "blocked" || s.status === "done" || s.status === "working", (e) => e.child(div().absolute().top(-2).right(-2).child(StatusDot(s.status, { size: 7 })))),
                s.branch ? `${s.name} · ${s.branch}` : s.name,
              ),
            ),
          ),
      );
  }

  render(cx) {
    const k = tokens();
    const narrow = sidebarNarrow();
    if (this.footer) return this.footerView(k, narrow);
    const center = activeChild(NODE.center);
    if (narrow) return this.railView(k, center);
    const { rows, order } = this.tree.build({ k, cx, preview: this.preview });
    if (!this.preview) setAgentOrder(order);
    const places = ["home", "work", ...this.pins()];
    return ViewRoot("lz-sidebar", { bg: k.bg.chrome })
      .px(8)
      .pt(4)
      .pb(8)
      .on_mouse_up("left", (_e, cx) => {
        if (!this.pinDrag && !this.tree.drag) return;
        this.pinDrag = null;
        this.tree.drag = null;
        cx.notify();
      })
      .child(this.searchField(k))
      .child(v_flex().flex_none().gap(1).role("list").accessibility_label(t("shell.nav.label")).children(places.map((place) => this.navRow(k, place, center))))
      .child(this.spacesHeader(k))
      .child(
        v_flex()
          .id("sb-tree")
          .flex_1()
          .min_h(0)
          .gap(1)
          .role("tree")
          .accessibility_label(t("shell.sidebar.spaces"))
          .overflow_y_scrollbar()
          .children(rows.length ? rows : [Text(t("shell.sidebar.noSpaces"), { size: "sm", tone: "tertiary" }).px(8).py(6)]),
      );
  }
}
