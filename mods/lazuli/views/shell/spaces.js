// The sidebar's space tree (mockup A, left column): machines ("이 Mac" first, then each remote machine), their spaces
// (folding chevron, name, branch; a worktree nested under its checkout's space), each space's tabs with their state
// dot, program or file mark and what stands out (응답 필요, how long it has worked, 저장 안 됨, the PR), the agents of
// a tab that runs several, and the sub-agents an agent started. Spaces reorder by drag within their machine, rename
// on double click, and open their menu on right click; tabs and agents open theirs.
// Reference: lstack-herdr-cockpit's `sidebar.js` (removed; git history ee5201a) spaceRows/termRows/subRows.

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { agents, exec, machines, panes, run, setShared, shared, spaces, terminals } from "herdr";
import { MOD, NODE } from "../../sys/state.js";
import { activeChild, showCenter } from "../../sys/bus.js";
import * as fleet from "../../sys/fleet.js";
import { registry, isDirty } from "../../sys/filetabs.js";
import { t } from "../../core/i18n.js";
import { Icon, ProgramIcon, Row, StatusDot, Text, withTooltip } from "../../ui/kit.js";
import { openMenu } from "./actions.js";
import { agentItems, spaceItems, tabItems } from "./menus.js";
import { agentName, dur, plainTabName } from "./format.js";

const FOLD_KEY = "lazuli.sidebar.folded";
const SUBS_SHOWN = 4;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v) => typeof v === "number" && Number.isFinite(v);
const stop = (_e, cx) => cx.stop_propagation();
const STATES = new Set(["working", "blocked", "done", "idle"]);

/** Where a space is now: its first terminal's live folder, else where it was made. */
function placeOf(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((tab) => tab.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder || null;
}

/** A small square button inside a dense row (machine "+", space chevron). */
function mini(k, id, icon, label, onUp) {
  return withTooltip(
    h_flex()
      .id(id)
      .flex_none()
      .size(18)
      .items_center()
      .justify_center()
      .rounded(k.radius.sm)
      .text_color(k.text.tertiary)
      .cursor_pointer()
      .accessibility_label(label)
      .hover((s) => s.bg(k.bg.hover).text_color(k.text.primary))
      .on_mouse_down("left", stop)
      .on_mouse_up("left", (_e, cx) => {
        cx.stop_propagation();
        onUp(cx);
      })
      .child(Icon(icon, { size: 12 })),
    label,
  );
}

export class SpaceTree {
  constructor() {
    this.repos = new Map();
    this.drag = null;
  }

  /** The space's checkout: `{common, linked}` for a git folder (asked of git once per folder), else null. */
  repoOf(cwd, cx, preview) {
    if (!cwd || preview) return null;
    if (this.repos.has(cwd)) return this.repos.get(cwd);
    this.repos.set(cwd, null);
    cx.spawn(async (cx) => {
      try {
        const r = await exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], { cwd, timeout: 5000 });
        if (r.code !== 0) return;
        const [top, common] = r.stdout.trim().split("\n");
        if (!top || !common) return;
        this.repos.set(cwd, { common, linked: common !== `${top}/.git` });
        cx.notify();
      } catch {}
    });
    return null;
  }

  folded() {
    const v = shared(FOLD_KEY);
    return new Set(Array.isArray(v) ? v : []);
  }

  setFolded(next) {
    setShared(FOLD_KEY, [...next]);
  }

  /** Every row of the tree and the agents in the order shown (for setAgentOrder). `o`: {k, cx, preview, now}. */
  build(o) {
    const { k, cx, preview } = o;
    this.preview = preview === true;
    const now = o.now ?? Date.now();
    const sp = spaces() ?? [];
    const ps = panes() ?? [];
    const ags = agents() ?? [];
    const terms = terminals() ?? [];
    const rowsByAddress = new Map(fleet.rows(now).map((r) => [r.address, r]));
    const files = new Map();
    for (const [fid, e] of Object.entries(registry())) if (isObj(e) && typeof e.file === "string" && e.tab) files.set(e.tab, { fid, e });
    const folded = this.folded();
    const center = activeChild(NODE.center);
    const order = [];
    const out = [];

    const known = (machines() ?? []).filter((m) => typeof m?.name === "string" && m.name !== "");
    const names = [null, ...known.map((m) => m.name)];
    for (const s of sp) if (typeof s.machine === "string" && s.machine && !names.includes(s.machine)) names.push(s.machine);
    const stateOf = (name) => (name === null ? "ready" : known.find((m) => m.name === name)?.layout ?? "ready");

    for (const machine of names) {
      const mine = sp.filter((s) => (s.machine ?? null) === machine);
      out.push(this.machineRow(k, machine, stateOf(machine), out.length > 0));
      const info = mine.map((s) => ({ s, place: placeOf(s, ps), repo: machine ? null : this.repoOf(placeOf(s, ps), cx, preview) }));
      const mains = new Set(info.filter((r) => r.repo && !r.repo.linked).map((r) => r.repo.common));
      const nested = (r) => Boolean(r.repo?.linked && mains.has(r.repo.common));
      const ordered = [];
      for (const r of info) {
        if (nested(r)) continue;
        ordered.push({ ...r, tree: false });
        if (r.repo && !r.repo.linked) for (const kid of info.filter((x) => nested(x) && x.repo.common === r.repo.common)) ordered.push({ ...kid, tree: true });
      }
      for (const r of ordered) {
        const isFolded = folded.has(r.s.id);
        out.push(this.spaceRow(k, r, isFolded, folded, center, preview));
        if (isFolded) continue;
        for (const tab of r.s.tabs ?? []) {
          if (tab.settled && !tab.active) continue;
          out.push(...this.tabRows(k, { s: r.s, tab, tree: r.tree, ps, ags, terms, rowsByAddress, files, center, now, order }));
        }
      }
    }
    return { rows: out, order };
  }

  machineRow(k, name, state, spaced) {
    const label = name === null ? t("shell.sidebar.thisMac") : String(name || t("shell.sidebar.thisMac"));
    const note = state === "loading" ? t("shell.sidebar.machineLoading") : state === "unavailable" ? t("shell.sidebar.machineOffline") : "";
    return h_flex()
      .id(`machine-${name ?? "local"}`)
      .flex_none()
      .h(22)
      .px(8)
      .gap(6)
      .items_center()
      .when(spaced, (e) => e.mt(6))
      .text_size(k.fontSize.xs)
      .line_height(`${k.lineHeight.xs}px`)
      .text_color(k.text.tertiary)
      .child(Icon("server", { size: 12 }))
      .child(div().flex_shrink(1).min_w(0).truncate().child(label))
      .when(Boolean(note), (e) => e.child(div().flex_none().text_color(state === "unavailable" ? k.state.warning : k.text.tertiary).child(note)))
      .child(div().flex_1())
      .when(state === "ready", (e) => e.child(mini(k, `machine-new-${name ?? "local"}`, "plus", t("shell.sidebar.newSpaceOn", { machine: label }), () => !this.preview && run("space.new", name ? { machine: name } : { machine: "" }))));
  }

  spaceRow(k, r, isFolded, folded, center, preview) {
    const { s, tree, place, repo } = r;
    const d = this.drag;
    const over = d && d.over === s.id && d.from !== s.id;
    const lifted = d && d.from === s.id && d.over !== s.id;
    const branch = s.branch && s.branch !== s.name ? s.branch : "";
    const fold = () => {
      const next = new Set(folded);
      if (isFolded) next.delete(s.id);
      else next.add(s.id);
      this.setFolded(next);
    };
    return withTooltip(
      h_flex()
        .id(`space-${s.id}`)
        .relative()
        .flex_none()
        .h(26)
        .pl(tree ? 20 : 6)
        .pr(8)
        .gap(6)
        .items_center()
        .rounded(k.radius.md)
        .cursor_pointer()
        .text_color(k.text.primary)
        .role("tree_item")
        .accessibility_label(branch ? `${s.name}, ${branch}` : s.name)
        .hover((st) => st.bg(k.bg.hover))
        .when(Boolean(lifted), (e) => e.opacity(0.5))
        .when(Boolean(over), (e) =>
          e.child(div().absolute().left(0).right(0).h(2).rounded(1).bg(k.accent).when((s.index ?? 0) > (d.fromIndex ?? 0), (l) => l.bottom(0)).when((s.index ?? 0) <= (d.fromIndex ?? 0), (l) => l.top(0))),
        )
        .on_mouse_down("left", () => {
          this.drag = { from: s.id, fromIndex: s.index, machine: s.machine ?? null, over: s.id };
        })
        .on_mouse_move((_e, cx) => {
          const drag = this.drag;
          if (drag && drag.machine === (s.machine ?? null) && drag.over !== s.id) {
            drag.over = s.id;
            cx.notify();
          }
        })
        .on_mouse_up("left", (e, cx) => {
          const drag = this.drag;
          this.drag = null;
          if (preview) return;
          if (drag && drag.from !== s.id && drag.over === s.id) run("space.move", { id: drag.from, index: s.index });
          else if (e?.click_count > 1) run("space.rename", { id: s.id });
          else {
            if (!s.active) run("space.select", { id: s.id });
            if (center !== "work") showCenter("work");
          }
          cx.notify();
        })
        .on_mouse_down("right", (_e, cx) => {
          cx.stop_propagation();
          if (!preview) openMenu(spaceItems(s, repo ? (repo.linked ? "linked" : "main") : null, place), { width: 240 });
        })
        .child(mini(k, `space-fold-${s.id}`, isFolded ? "chevron-right" : "chevron-down", isFolded ? t("shell.sidebar.unfoldSpace") : t("shell.sidebar.foldSpace"), () => !this.preview && fold()))
        .when(tree, (e) => e.child(Icon("git-branch", { size: 12, color: k.text.tertiary })))
        .child(div().flex_none().max_w(150).truncate().font_weight(k.weight.medium).child(s.name))
        .child(div().flex_1().min_w(0).truncate().font_family(k.fonts.mono).text_size(k.fontSize.xs).text_color(k.text.tertiary).child(branch))
        .when(isFolded && STATES.has(s.status) && s.status !== "idle", (e) => e.child(StatusDot(s.status, { label: t(`shell.agent.status.${s.status}`) }))),
      t("shell.sidebar.spaceHint"),
    );
  }

  /** A tab's row, then its agents when it runs several, then each agent's sub-agents. */
  tabRows(k, c) {
    const { s, tab, tree, ps, ags, terms, rowsByAddress, files, center, now, order } = c;
    const indent = tree ? 32 : 18;
    const tabAgents = ags.filter((a) => a.tab === tab.id);
    const tabPanes = ps.filter((p) => p.tab === tab.id);
    const file = files.get(tab.id) ?? null;
    const dirty = file ? isDirty(file.fid) : false;
    const lead = tabAgents[0] ?? null;
    const leadRow = lead ? rowsByAddress.get(lead.address) ?? { ...lead } : null;
    for (const a of tabAgents) order.push(a.address);

    // The mark: a file's, the agent's program, else the first terminal's program.
    let mark;
    if (file) mark = Icon(file.e.preview ? "eye" : "file-text", { size: 13, color: k.text.secondary });
    else if (lead) mark = ProgramIcon(lead.program, { size: 14 });
    else {
      const first = tabPanes.find((p) => p.terminal) ?? tabPanes[0];
      mark = first?.terminal ? ProgramIcon(first.program, { size: 14 }) : first?.mod && first.mod !== MOD ? Icon("layers", { size: 13 }) : Icon("terminal", { size: 13 });
    }
    const status = STATES.has(tab.status) ? tab.status : "idle";
    const dot = dirty
      ? div().flex_none().size(7).rounded(k.radius.full).border(1.5).border_color(k.state.blocked).accessibility_label(t("shell.sidebar.unsaved"))
      : StatusDot(status, { label: t(`shell.agent.status.${status}`) });

    // What stands out, most urgent first.
    let detail = "";
    let detailTone = "tertiary";
    const pr = tabAgents.map((a) => rowsByAddress.get(a.address)?.pr).find((p) => p?.number);
    if (dirty) [detail, detailTone] = [t("shell.sidebar.unsaved"), "blocked"];
    else if (tab.status === "blocked") [detail, detailTone] = [t("shell.sidebar.needsYou"), "blocked"];
    else if (tab.status === "working" && num(tab.working_since)) detail = dur(now - tab.working_since);
    else if (file?.e.preview) detail = t("shell.sidebar.preview");
    else if (pr) detail = `#${pr.number}`;

    const current = s.active && tab.active && center === "work";
    const select = () => {
      // The work view's agent child shows the agent chosen with agent.focus, and Herdr keeps that agent's pane (and
      // so its tab) focused: a tab without an agent selected under it snaps back. Show the tab's panes first.
      if (!tabAgents.length && activeChild(NODE.view) === "agent") run("layout.select", { stack: NODE.view, child: "main" });
      if (!s.active) run("space.select", { id: s.id });
      if (!tab.active || !s.active) run("tab.select", { id: tab.id });
      if (center !== "work") showCenter("work");
    };
    const out = [
      Row(`tab-${tab.id}`, {
        leading: h_flex().flex_none().gap(8).items_center().child(dot).child(mark),
        label: plainTabName(tab.name),
        detail,
        detailTone,
        current,
        indent,
        onClick: () => !this.preview && select(),
        onSecondaryClick: (_e, cx) => {
          cx.stop_propagation();
          if (!this.preview) openMenu(tabItems(s, tab, tabAgents.length === 1 ? leadRow : null, now), { width: 250 });
        },
        tooltip: tabAgents.length === 1 && leadRow ? `${agentName(leadRow)} · ${s.name}` : undefined,
      }),
    ];
    if (tabAgents.length > 1) {
      for (const a of tabAgents) {
        const row = rowsByAddress.get(a.address) ?? a;
        const st = STATES.has(a.status) ? a.status : "idle";
        out.push(
          Row(`ag-${a.address}`, {
            size: "sm",
            leading: h_flex().flex_none().gap(8).items_center().child(StatusDot(st, { size: 6, label: t(`shell.agent.status.${st}`) })).child(ProgramIcon(a.program, { size: 13 })),
            label: agentName(row),
            detail: a.status === "blocked" ? t("shell.sidebar.needsYou") : row.pr?.number ? `#${row.pr.number}` : "",
            detailTone: a.status === "blocked" ? "blocked" : "tertiary",
            current: Boolean(a.focused) && current,
            indent: indent + 16,
            onClick: () => !this.preview && fleet.goTo(a.address),
            onSecondaryClick: (_e, cx) => {
              cx.stop_propagation();
              if (!this.preview) openMenu(agentItems(row, now), { width: 250 });
            },
          }),
        );
        out.push(...this.subRows(k, a, terms, indent + 30));
      }
    } else if (lead) out.push(...this.subRows(k, lead, terms, indent + 18));
    return out;
  }

  /** Live terminals an agent started (`hc run`, Herdr's `parent`), as tree lines under it; a click peeks. */
  subRows(k, a, terms, indent) {
    const kids = terms.filter((x) => x.parent === a.address && x.state === "live");
    if (!kids.length) return [];
    const shown = kids.length > SUBS_SHOWN ? kids.slice(0, SUBS_SHOWN - 1) : kids;
    const out = shown.map((x, i) => {
      const st = STATES.has(x.status) ? x.status : "idle";
      return Row(`sub-${x.address}`, {
        size: "sm",
        leading: Text(i === shown.length - 1 && shown.length === kids.length ? "└" : "├", { size: "xs", tone: "tertiary" }),
        label: x.name || x.template || x.program?.name || x.address,
        trailing: [StatusDot(st, { size: 6, label: t(`shell.agent.status.${st}`) })],
        indent,
        onClick: () => !this.preview && run("terminal.peek", { terminal: x.address }),
        tooltip: t("shell.sidebar.peek"),
      });
    });
    if (kids.length > shown.length) out.push(Row(`sub-more-${a.address}`, { size: "sm", label: t("shell.sidebar.moreSubs", { count: kids.length - shown.length }), indent: indent + 14, tone: "tertiary" }));
    return out;
  }
}
