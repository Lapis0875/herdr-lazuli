// A pane's header in the work view (layout `main`, `pane.header`; Herdr gives each copy `props().pane` and
// `props().terminal`, H/AGENTS.md Pane frames).
// - A lazuli file tab's pane, or its HTML viewer pane: the file tab's own header row (U5's file/ui/head.js: breadcrumb,
//   save state, Edit / Split / Preview, view in Chrome), so a file tab has one header row as in mockup A; the file view
//   hides its own row while this one draws it.
// - Any other pane: the program and its title, its folder, branch and agent state.
// On hover or while focused, the pane's controls follow on the right: open in the external editor, fork the agent's
// session, split right or down, zoom, close. A click focuses the pane; a double click on a terminal's header zooms it.

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, props, run, spaces } from "herdr";
import { entryOf } from "../sys/filetabs.js";
import { fileHeadFor, fileHeader, fileHeadActions } from "../file/ui/head.js";
import { t } from "../core/i18n.js";
import { tokens } from "../ui/tokens.js";
import { ViewRoot, Icon, IconButton, ProgramIcon, Spinner, StatusDot, Badge, Text } from "../ui/kit.js";
import { act, canFork, editorName } from "./shell/actions.js";
import { shortPath } from "./shell/format.js";

// The pane frame draws the fill and rounded corners; the header lets them show.
const CLEAR = "#00000000";
// One control's room in the row: a 26 px button and the 2 px gap before it.
const CONTROL_W = 28;
const isAgent = (p) => Boolean(p?.program?.agent || p?.app || p?.status);

export default class PaneHead {
  constructor(name) {
    this.name = name;
  }

  init(p, _cx) {
    this.props = props() ?? p ?? {};
    this.hovered = false;
    this.width = 0;
  }

  me() {
    const id = props()?.pane ?? this.props.pane;
    return id ? (panes() ?? []).find((x) => x.pane === id) ?? null : null;
  }

  status(st) {
    if (st === "working") return Spinner({ size: 12, label: t("shell.stage.working") });
    if (st === "blocked") return Badge(t("shell.pane.needsYou"), { tone: "blocked" });
    if (st === "done") return StatusDot("done", { label: t("shell.stage.done") });
    return null;
  }

  /** The pane's controls, shown on hover or while it has the keyboard. `edit`: the path the editor opens. */
  controls(p, edit, machine) {
    const pane = p.pane;
    const button = (id, glyph, label, action) =>
      IconButton(`ph-${id}-${pane}`, glyph, label, {
        iconSize: 14,
        onClick: (_e, cx) => {
          cx.stop_propagation();
          action();
        },
      });
    return [
      edit && button("editor", "code", t("shell.pane.editor", { editor: editorName() }), () => act({ kind: "editor", path: edit.path, on: edit.on ?? machine, folder: edit.folder === true })),
      p.terminal && isAgent(p) && canFork(p.terminal) && button("fork", "git-fork", t("shell.pane.fork"), () => act({ kind: "fork", address: p.terminal, place: "tab" })),
      button("split-right", "columns", t("shell.pane.splitRight"), () => run("pane.split", { direction: "right", pane })),
      button("split-down", "rows-2", t("shell.pane.splitDown"), () => run("pane.split", { direction: "down", pane })),
      button("zoom", p.zoomed ? "minimize-2" : "maximize-2", p.zoomed ? t("shell.pane.unzoom") : t("shell.pane.zoom"), () => run("pane.zoom", { pane })),
      button("close", "x", t("shell.pane.close"), () => run("pane.close", { pane })),
    ].filter(Boolean);
  }

  render(_cx) {
    const k = tokens();
    const preview = props()?.preview === true;
    const root = ViewRoot("lz-pane-head", { bg: CLEAR })
      .flex_row()
      .items_center()
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) < 1) return;
        this.width = size.width;
        cx.notify();
      })
      .on_hover((hovered, cx) => {
        if (this.hovered === hovered) return;
        this.hovered = hovered;
        cx.notify();
      });
    const p = this.me();
    if (!p) return root;
    const pane = p.pane;
    const machine = (spaces() ?? []).find((s) => (s.tabs ?? []).some((tab) => tab.id === p.tab))?.machine ?? null;
    const showControls = !preview && (this.hovered || p.focused);
    const focus = () => {
      if (!preview && !p.focused) run("pane.focus", { pane });
    };

    const head = fileHeadFor(pane);
    if (head) {
      const entry = entryOf(head.fid);
      const controls = showControls ? this.controls(p, entry ? { path: entry.file, on: entry.on || null } : null, machine) : [];
      const width = this.width ? Math.max(0, this.width - controls.length * CONTROL_W - (controls.length ? 4 : 0)) : 0;
      return root
        .on_click(() => focus())
        .child(div().flex_1().min_w(0).h_full().child(fileHeader(head.state, { compact: true, width, ...(preview ? {} : fileHeadActions(head.fid)) })))
        .when(controls.length > 0, (e) => e.child(h_flex().flex_none().h_full().pr(4).gap(2).items_center().children(controls)));
    }

    const icon = p.terminal ? ProgramIcon(p.program, { size: 14 }) : Icon("layers", { size: 14, color: k.text.secondary });
    const program = p.program?.agent || p.program?.shell ? p.program.name : null;
    const name = program || p.title || p.program?.name || p.mod || t("shell.pane.terminal");
    const title = typeof p.title === "string" ? p.title.replace(/^[^@\s]+@[^:\s]+:\s*/, "") : "";
    const st = this.status(p.status);
    const controls = showControls ? this.controls(p, p.cwd ? { path: p.cwd, on: machine, folder: true } : null, machine) : [];
    return root
      .pl(10)
      .pr(4)
      .gap(8)
      .text_size(k.fontSize.sm)
      .line_height(`${k.lineHeight.sm}px`)
      .border_b(1)
      .border_color(k.line.soft)
      .on_click((e, _cx) => {
        if (preview) return;
        if (e?.click_count === 2) run("pane.zoom", { pane });
        else focus();
      })
      .child(icon)
      .child(div().flex_none().max_w(260).truncate().font_weight(k.weight.medium).text_color(p.focused ? k.text.primary : k.text.secondary).child(name))
      .when(Boolean(program && title && title !== name && title !== p.terminal), (e) => e.child(Text(title, { size: "sm", tone: "secondary", truncate: true }).max_w(280)))
      .child(div().flex_1().min_w(0).truncate().text_color(k.text.tertiary).child(shortPath(p.cwd)))
      .when(Boolean(p.branch) && !showControls, (e) => e.child(div().flex_none().max_w(180).truncate().font_family(k.fonts.mono).text_size(k.fontSize.xs).text_color(k.text.tertiary).child(p.branch)))
      .when(Boolean(st), (e) => e.child(st))
      .when(controls.length > 0, (e) => e.child(h_flex().flex_none().gap(2).items_center().children(controls)));
  }
}
