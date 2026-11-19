// The kit gallery: every ui/kit.js component in each of its states, for screenshots in both appearances
// (`tab.new {mod: "lazuli", props: {view: "gallery"}}`). Static states use the kit's `look` option; the
// controls also work live (hover, press, Tab, typing, switching tabs, checking boxes, dismissing banners).

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState } from "gpui-base";
import { t } from "../core/i18n.js";
import { tokens } from "../ui/tokens.js";
import {
  ViewRoot, Text, Spacer, Icon, AgentMark, ProgramIcon, Logo, LogoMark, Spinner, Kbd, Count, Badge,
  Chip, PrChip, CiChip, BranchChip, StatusDot, Button, IconButton, CheckBox, Row, SectionHeader, Card,
  trackFocus, TextInput, Field, Segmented, TabBar, Menu, MenuItem, MenuLabel, MenuSeparator, Empty, EmptySlot,
  Banner, withTooltip,
} from "../ui/kit.js";

// Every icon under ui/icons/.
const ICONS = [
  "activity", "alarm-clock", "app-window", "arrow-down", "arrow-up", "arrow-up-to-line", "bell", "bell-dot", "bot",
  "calendar-clock", "chart-column", "check", "chevron-down", "chevron-left", "chevron-right", "chevron-up",
  "chevrons-down-up", "chevrons-up-down", "circle", "circle-check", "circle-dashed", "circle-dot", "circle-help",
  "circle-pause", "circle-stop", "circle-x", "clock", "code", "columns", "command", "copy", "corner-down-left",
  "external", "eye", "eye-off", "file", "file-code", "file-diff", "file-plus", "file-text", "files", "folder",
  "folder-git", "folder-plus", "git-branch", "git-compare", "git-fork", "git-merge", "git-pull-request",
  "git-pull-request-draft", "globe", "hand", "history", "hourglass", "image", "inbox", "info", "keyboard",
  "languages", "layers", "layout-dashboard", "layout-template", "link", "list", "list-ordered", "list-todo", "loader",
  "lock", "map", "maximize-2", "message-square", "message-square-plus", "minimize-2", "more", "move-horizontal",
  "move-vertical", "palette", "panel-left", "pencil", "pin", "play", "plus", "refresh-cw", "reply", "rotate-ccw",
  "route", "rows-2", "scan", "scan-eye", "scroll-text", "search", "send", "server", "settings", "shield-check",
  "sidebar", "skip-forward", "sparkles", "square-pen", "square-split", "terminal", "ticket", "timer", "trash-2",
  "triangle-alert", "undo", "user", "users", "workflow", "wrench", "x", "zap", "zoom-in", "zoom-out",
];

const STATES = ["working", "blocked", "done", "idle", "unknown"];

export default class Gallery {
  constructor(name) {
    this.name = name;
  }

  init(_props, _cx) {
    this.mode = "split";
    this.inboxTab = "reviews";
    this.checks = { one: false, two: true };
    this.dismissed = new Set();
    this.clicks = 0;
    this.inputs = {
      plain: InputState.new({ placeholder: t("gallery.field.namePlaceholder") }),
      focused: InputState.new({ placeholder: t("gallery.field.namePlaceholder") }),
      invalid: InputState.new({ value: "daily-recap" }),
      filled: InputState.new({ value: "omp -p {prompt}" }),
      search: InputState.new({ placeholder: t("gallery.field.search") }),
    };
    this.focus = Object.fromEntries(Object.entries(this.inputs).map(([key, state]) => [key, trackFocus(state)]));
  }

  // One gallery card: a header and its content.
  section(id, title, children, width = 460) {
    return Card({ id: `g-${id}`, tone: "panel", gap: 12, pad: 16, children: [SectionHeader({ title }), ...children] }).w(width).flex_none();
  }

  // A small caption above a sample.
  labeled(label, el) {
    return v_flex().gap(6).items_start().child(Text(label, { size: "xs", tone: "tertiary", nowrap: true })).child(el);
  }

  // A row of samples that wraps.
  line(children, gap = 10) {
    return h_flex().flex_wrap().gap(gap).items_center().children(children);
  }

  swatch(name, color, k) {
    return v_flex()
      .w(96)
      .gap(4)
      .child(div().h(28).rounded(k.radius.md).border_1().border_color(k.line.soft).bg(color))
      .child(Text(name, { size: "xs", tone: "secondary", mono: true, truncate: true }))
      .child(Text(color, { size: "xs", tone: "tertiary", mono: true }));
  }

  colors(k) {
    const group = (title, entries) =>
      v_flex().gap(8).child(Text(title, { size: "sm", tone: "secondary", weight: "medium" })).child(this.line(entries.map(([n, c]) => this.swatch(n, c, k)), 8));
    return [
      group(t("gallery.group.bg"), [
        ["bg.app", k.bg.app], ["bg.chrome", k.bg.chrome], ["bg.card", k.bg.card], ["bg.surface", k.bg.surface],
        ["bg.raised", k.bg.raised], ["bg.popover", k.bg.popover], ["bg.hover", k.bg.hover], ["bg.selected", k.bg.selected],
        ["selection", k.selection], ["line.soft", k.line.soft], ["line.strong", k.line.strong],
      ]),
      group(t("gallery.group.text"), [
        ["text.primary", k.text.primary], ["text.secondary", k.text.secondary], ["text.tertiary", k.text.tertiary],
        ["text.onAccent", k.text.onAccent], ["accent", k.accent], ["accent2", k.accent2], ["button.bg", k.button.bg], ["button.text", k.button.text],
      ]),
      group(t("gallery.group.state"), [
        ["state.working", k.state.working], ["state.blocked", k.state.blocked], ["state.done", k.state.done],
        ["state.idle", k.state.idle], ["state.unknown", k.state.unknown], ["state.error", k.state.error],
      ]),
      group(t("gallery.group.diff"), [
        ["diff.add", k.diff.add], ["diff.remove", k.diff.remove], ["diff.addBg", k.diff.addBg], ["diff.removeBg", k.diff.removeBg],
        ...Object.entries(k.syntax).map(([n, c]) => [`syntax.${n}`, c]),
      ]),
      v_flex()
        .gap(8)
        .child(Text(t("gallery.group.ansi"), { size: "sm", tone: "secondary", weight: "medium" }))
        .child(
          h_flex().gap(4).children(
            k.ansi.map((c, i) =>
              v_flex().gap(4).items_center()
                .child(div().size(26).rounded(k.radius.sm).border_1().border_color(k.line.soft).bg(c))
                .child(Text(String(i), { size: "xs", tone: "tertiary", mono: true })),
            ),
          ),
        ),
    ];
  }

  type(k) {
    const sizes = ["xxl", "xl", "lg", "md", "sm", "xs"];
    return [
      ...sizes.map((s) =>
        h_flex().gap(12).items_baseline().min_w(0)
          .child(Text(`${s} ${k.fontSize[s]}/${k.lineHeight[s]}`, { size: "xs", tone: "tertiary", mono: true }).w(72).flex_none())
          .child(Text(t("gallery.type.sample"), { size: s, truncate: true }).flex_1()),
      ),
      this.line(["regular", "medium", "semibold", "bold"].map((w) => Text(t(`gallery.weight.${w}`), { weight: w })), 16),
      Text(t("gallery.type.mono"), { size: "sm", mono: true, tone: "secondary" }),
      div().w(240).p(8).rounded(k.radius.md).border_1().border_dashed().border_color(k.line.soft).child(Text(t("gallery.type.wrap"), { size: "sm" })),
    ];
  }

  buttons() {
    const looks = [["rest", undefined], ["hover", "hover"], ["active", "active"], ["focus", "focus"]];
    const row = (variant, label, opts = {}) =>
      this.line([
        ...looks.map(([state, look]) =>
          this.labeled(t(`gallery.state.${state}`), Button(`g-btn-${variant}-${state}`, label, { variant, look, onClick: (_e, cx) => this.click(cx), ...opts })),
        ),
        this.labeled(t("gallery.state.disabled"), Button(`g-btn-${variant}-off`, label, { variant, disabled: true, ...opts })),
      ]);
    return [
      Text(t("gallery.variant.primary"), { size: "sm", tone: "secondary", weight: "medium" }),
      row("primary", t("gallery.sample.reply"), { kbd: "⌘J" }),
      Text(t("gallery.variant.secondary"), { size: "sm", tone: "secondary", weight: "medium" }),
      row("secondary", t("gallery.sample.retryAll"), { kbd: "⌥⌘R" }),
      Text(t("gallery.variant.ghost"), { size: "sm", tone: "secondary", weight: "medium" }),
      row("ghost", t("gallery.sample.recap"), { icon: "sparkles", kbd: "⌘R" }),
      Text(t("gallery.variant.small"), { size: "sm", tone: "secondary", weight: "medium" }),
      this.line([
        Button("g-btn-sm-1", t("common.save"), { variant: "primary", size: "sm" }),
        Button("g-btn-sm-2", t("common.cancel"), { size: "sm" }),
        Button("g-btn-sm-3", t("gallery.sample.later"), { variant: "ghost", size: "sm" }),
        Text(`${this.clicks}`, { size: "xs", tone: "tertiary", mono: true }),
      ]),
    ];
  }

  iconButtons(k) {
    const looks = [["rest", undefined], ["hover", "hover"], ["active", "active"], ["focus", "focus"]];
    const rail = v_flex().gap(4).p(6).items_center().rounded(k.radius.lg).border_1().border_color(k.line.soft).bg(k.bg.card)
      .child(IconButton("g-rail-review", "git-pull-request", t("gallery.sample.review"), { size: "lg" }))
      .child(IconButton("g-rail-files", "folder", t("gallery.sample.files"), { size: "lg", selected: true }))
      .child(IconButton("g-rail-changes", "file-diff", t("gallery.sample.changes"), { size: "lg" }))
      .child(IconButton("g-rail-tree", "workflow", t("gallery.sample.tree"), { size: "lg" }));
    return [
      this.line([
        ...looks.map(([state, look]) => this.labeled(t(`gallery.state.${state}`), IconButton(`g-ib-${state}`, "search", t("gallery.sample.search"), { look }))),
        this.labeled(t("gallery.state.selected"), IconButton("g-ib-sel", "folder", t("gallery.sample.files"), { selected: true })),
        this.labeled(t("gallery.state.disabled"), IconButton("g-ib-off", "file-plus", t("gallery.sample.newFile"), { disabled: true })),
      ]),
      h_flex().gap(24).items_start()
        .child(rail)
        .child(v_flex().gap(12)
          .child(this.labeled(t("gallery.sample.notifications"), IconButton("g-ib-bell", "bell", t("gallery.sample.notifications"), { count: 3 })))
          .child(this.labeled(t("gallery.sample.collapseSidebar"), IconButton("g-ib-side", "sidebar", t("gallery.sample.collapseSidebar"))))),
    ];
  }

  icons(k) {
    return [
      h_flex().flex_wrap().gap(4).children(
        ICONS.map((name) =>
          v_flex().w(92).h(52).gap(6).items_center().justify_center().rounded(k.radius.md).text_color(k.text.secondary)
            .child(Icon(name, { size: k.icon.md }))
            .child(Text(name, { size: "xs", tone: "tertiary", truncate: true }).max_w(88)),
        ),
      ),
    ];
  }

  marks(k) {
    return [
      this.line([16, 20, 32, 48].map((s) => this.labeled(`${s}`, Logo({ size: s }))), 16),
      this.line([
        this.labeled("16", LogoMark({ size: 16, color: k.text.primary })),
        this.labeled("20", LogoMark({ size: 20, color: k.accent })),
        this.labeled("32", LogoMark({ size: 32, color: k.text.secondary })),
      ], 16),
      this.line(["claude", "codex", "omp"].map((key) =>
        this.labeled(key, h_flex().gap(8).items_center().text_color(k.text.primary).child(AgentMark(key, { size: 14 })).child(AgentMark(key, { size: 16 }))),
      ).concat(this.labeled("zsh", ProgramIcon(null, { size: 14, color: k.text.secondary }))), 16),
    ];
  }

  status() {
    return [
      this.line(STATES.map((s) => this.labeled(t(`gallery.status.${s}`), StatusDot(s, { label: t(`gallery.status.${s}`) }))), 18),
      this.line([
        this.labeled(t("gallery.state.pulse"), StatusDot("working", { pulse: true, label: t("gallery.status.working") })),
        this.labeled("10 px", StatusDot("blocked", { size: 10, label: t("gallery.status.blocked") })),
      ], 18),
    ];
  }

  counts(k) {
    const tones = ["accent", "accent2", "working", "blocked", "done", "error", "idle"];
    return [
      this.line([
        this.labeled(t("gallery.variant.secondary"), Count(3)),
        this.labeled(t("gallery.sample.waiting"), Count(5, { tone: "wait", label: t("gallery.sample.waitingCount", { n: 5 }) })),
        this.labeled(t("gallery.variant.primary"), Count(12, { tone: "accent" })),
        this.labeled(t("gallery.sample.notifications"), div().p(4).bg(k.bg.app).rounded(k.radius.md).child(Count(3, { tone: "wait", ring: k.bg.app }))),
      ], 16),
      this.labeled(t("gallery.variant.soft"), this.line(tones.map((tone) => Badge(tone, { tone })), 6)),
      this.labeled(t("gallery.variant.solid"), this.line(["accent", "blocked", "done", "error"].map((tone) => Badge(tone, { tone, variant: "solid" })), 6)),
      this.labeled(t("gallery.variant.text"), this.line([
        Badge(t("gallery.sample.reviewRequested"), { tone: "blocked", variant: "text" }),
        Badge(t("gallery.sample.ciFailed"), { tone: "error", variant: "text" }),
        Badge(t("gallery.sample.comments", { n: 3 }), { tone: "secondary", variant: "text" }),
      ], 12)),
    ];
  }

  chips() {
    return [
      this.line([PrChip(51), PrChip(48, { state: "draft" }), PrChip(47, { state: "merged" }), PrChip(12, { state: "closed" })], 6),
      this.line(["pass", "fail", "running", "pending"].map((s) => CiChip(s, t(`gallery.ci.${s}`))), 6),
      this.line([
        BranchChip("feat/pdf-daemon"),
        Chip(t("gallery.sample.approved", { n: 2 }), { icon: "check", tone: "ok" }),
        Chip(t("gallery.sample.merged"), { tone: "merged" }),
        Chip("mac-mini", { icon: "server" }),
        Chip("#214", { id: "g-chip-click", icon: "git-pull-request", tone: "pr", onClick: (_e, cx) => this.click(cx), tooltip: "herdr-relay #214" }),
      ], 6),
    ];
  }

  kbds(k) {
    return [
      this.line(["⇧⌘P", "⌥⌘0", "⌘J", "⇧⌘U", "⌘1", "⌘⇧V", "⌥⌘Q"].map((keys) => Kbd(keys)), 14),
      this.line([
        h_flex().h(30).px(8).gap(8).items_center().rounded(k.radius.md).border_1().border_color(k.line.soft).bg(k.bg.card).w(240)
          .child(Icon("command", { size: 13, color: k.text.tertiary }))
          .child(Text(t("gallery.field.search"), { size: "sm", tone: "tertiary", truncate: true }).flex_1())
          .child(Kbd("⇧⌘P")),
      ]),
    ];
  }

  rows(k) {
    const agent = (status, key) => h_flex().gap(8).items_center().child(StatusDot(status, { label: t(`gallery.status.${status}`) })).child(AgentMark(key, { size: 14 }));
    const nav = v_flex().w(240).gap(1)
      .child(Row("g-nav-home", { icon: "layout-dashboard", label: t("gallery.sample.home"), selected: true, trailing: [Kbd("⌥⌘0")], onClick: () => {} }))
      .child(Row("g-nav-work", { icon: "columns", label: t("gallery.sample.work"), onClick: () => {} }))
      .child(Row("g-nav-inbox", { icon: "inbox", label: t("gallery.sample.inbox"), trailing: [Count(5, { tone: "wait" })], onClick: () => {} }))
      .child(Row("g-nav-todo", { icon: "list-todo", label: t("gallery.sample.todo"), trailing: [Count(3)], onClick: () => {}, look: "hover" }))
      .child(Row("g-nav-routines", { icon: "calendar-clock", label: t("gallery.sample.routines"), trailing: [StatusDot("working", { size: 6 })], onClick: () => {} }));
    const agents = v_flex().w(240).gap(1)
      .child(Row("g-ag-1", { leading: agent("working", "omp"), label: t("gallery.sample.agentPreview"), detail: t("gallery.sample.minutes", { n: 23 }), current: true, indent: 18, onClick: () => {} }))
      .child(Row("g-ag-2", { leading: agent("blocked", "claude"), label: t("gallery.sample.agentFiles"), detail: t("gallery.sample.needsReply"), detailTone: "blocked", indent: 18, onClick: () => {} }))
      .child(Row("g-ag-3", { leading: agent("done", "codex"), label: t("gallery.sample.agentPdf"), detail: "#47", indent: 18, onClick: () => {} }))
      .child(Row("g-ag-4", { leading: h_flex().gap(8).items_center().child(StatusDot("idle")).child(Icon("terminal", { size: 13 })), label: "zsh", indent: 18, onClick: () => {} }));
    const tree = v_flex().w(240)
      .child(Row("g-tr-1", { size: "sm", leading: Icon("chevron-down", { size: 12, color: k.text.tertiary }), label: "docs", tone: "primary", detail: "•", detailTone: "done", onClick: () => {} }))
      .child(Row("g-tr-2", { size: "sm", leading: div().size(12), label: "DESIGN.md", tone: "primary", indent: 14, detail: "U", detailTone: "done", trailing: [Icon("eye", { size: 13, color: k.text.tertiary })], onClick: () => {} }))
      .child(Row("g-tr-3", { size: "sm", leading: div().size(12), label: "keys.json", tone: "primary", detail: "M", detailTone: "working", onClick: () => {} }))
      .child(Row("g-tr-4", { size: "sm", leading: div().size(12), label: "README.md", tone: "primary", detail: "M", detailTone: "working", selected: true, onClick: () => {} }))
      .child(Row("g-tr-5", { size: "sm", leading: div().size(12), label: ".gitignore", tone: "tertiary", onClick: () => {} }));
    return [h_flex().gap(16).items_start().flex_wrap().child(nav).child(agents), tree];
  }

  headers(k) {
    return [
      SectionHeader({ icon: "inbox", title: t("gallery.sample.inbox"), count: 5, shortcut: "⌥⌘1" }),
      SectionHeader({ variant: "column", icon: "hand", iconColor: k.state.blocked, title: t("gallery.sample.waiting"), count: 2, shortcut: "⌘J" }),
      SectionHeader({ variant: "column", icon: "loader", iconColor: k.state.working, title: t("gallery.sample.working"), count: 3 }),
      div().w(240).bg(k.bg.chrome).rounded(k.radius.md).py(4).child(
        SectionHeader({ variant: "sidebar", title: t("gallery.sample.spaces"), trailing: [IconButton("g-sec-add", "plus", t("gallery.sample.spaces"), { iconSize: 13 })] }),
      ),
    ];
  }

  cards(k) {
    const who = (key, name, repo, elapsed, wait) =>
      h_flex().gap(7).items_center().min_w(0)
        .child(AgentMark(key, { size: 14, color: k.text.primary }))
        .child(Text(name, { size: "sm", weight: "medium", nowrap: true }))
        .child(Text(repo, { size: "sm", tone: "secondary", truncate: true }))
        .child(Spacer())
        .child(Text(elapsed, { size: "xs", tone: wait ? "blocked" : "tertiary", mono: true, nowrap: true }));
    return [
      h_flex().gap(12).items_start().flex_wrap()
        .child(this.labeled(t("gallery.sample.waiting"), Card({ tone: "wait", children: [
          who("claude", "Claude Code", "lazuli", t("gallery.sample.minutes", { n: 6 }), true),
          Text(t("gallery.sample.taskWait")),
          this.line([PrChip(48, { state: "draft" }), CiChip("pass", t("gallery.ci.pass"))], 4),
        ] }).w(200)))
        .child(this.labeled(t("gallery.state.rest"), Card({ id: "g-card-rest", onClick: () => {}, children: [
          who("omp", "omp", "lazuli", t("gallery.sample.minutes", { n: 23 })),
          Text(t("gallery.sample.taskWork")),
          this.line([PrChip(51), CiChip("running", t("gallery.ci.running"))], 4),
        ] }).w(200))),
      h_flex().gap(12).items_start().flex_wrap()
        .child(this.labeled(t("gallery.state.hover"), Card({ id: "g-card-hover", look: "hover", children: [
          who("codex", "Codex", "lazuli", t("gallery.sample.hoursAgo", { n: 2 })),
          Text(t("gallery.sample.taskDone")),
        ] }).w(200)))
        .child(this.labeled(t("gallery.state.selected"), Card({ selected: true, children: [
          who("codex", "Codex", "lazuli", t("gallery.sample.hoursAgo", { n: 2 })),
          Text(t("gallery.sample.taskDone")),
        ] }).w(200))),
    ];
  }

  fields() {
    const f = this.focus;
    return [
      Field({ label: t("gallery.field.name"), hint: t("gallery.field.nameHint"), control: TextInput(this.inputs.plain, { id: "g-in-plain", focused: f.plain.focused }) }),
      this.labeled(t("gallery.state.focus"), TextInput(this.inputs.focused, { id: "g-in-focus", focused: true })),
      Field({ label: t("gallery.field.name"), error: t("gallery.field.nameTaken"), control: TextInput(this.inputs.invalid, { id: "g-in-invalid", focused: f.invalid.focused, invalid: true }) }),
      Field({ label: t("gallery.field.command"), control: TextInput(this.inputs.filled, { id: "g-in-filled", focused: f.filled.focused, mono: true }) }),
      TextInput(this.inputs.search, { id: "g-in-search", focused: f.search.focused, icon: "search", a11y: t("gallery.sample.search") }),
    ];
  }

  tabs() {
    const modes = [
      { key: "edit", label: t("gallery.tab.edit"), icon: "pencil" },
      { key: "split", label: t("gallery.tab.split"), icon: "square-split" },
      { key: "preview", label: t("gallery.tab.preview"), icon: "eye" },
    ];
    return [
      Segmented("g-seg", modes, this.mode, (key, cx) => { this.mode = key; cx.notify(); }, { label: t("gallery.tab.mode") }),
      this.labeled(t("gallery.tab.pdfOnly"), Segmented("g-seg-pdf", modes.map((m) => ({ ...m, disabled: m.key !== "preview" })), "preview", () => {}, { label: t("gallery.tab.mode") })),
      TabBar("g-tabs", [
        { key: "reviews", label: t("gallery.tab.reviews"), count: 2 },
        { key: "prs", label: t("gallery.tab.prs"), count: 5 },
        { key: "ci", label: t("gallery.tab.ci"), count: 1 },
      ], this.inboxTab, (key, cx) => { this.inboxTab = key; cx.notify(); }, { label: t("gallery.tab.inbox") }),
    ];
  }

  menu() {
    return [
      Menu({ id: "g-menu", label: t("gallery.menu.label"), children: [
        MenuLabel(t("gallery.menu.group")),
        MenuItem("g-mi-open", { icon: "external", label: t("gallery.menu.openTab"), kbd: "⌘↩", selected: true }),
        MenuItem("g-mi-rename", { icon: "pencil", label: t("gallery.menu.rename"), look: "hover" }),
        MenuItem("g-mi-copy", { icon: "files", label: t("gallery.menu.copyPath"), kbd: "⌥⌘C" }),
        MenuItem("g-mi-reveal", { icon: "folder", label: t("gallery.menu.reveal") }),
        MenuItem("g-mi-wrap", { label: t("gallery.menu.wrap"), checked: true }),
        MenuItem("g-mi-remote", { icon: "server", label: t("gallery.menu.remote"), disabled: true }),
        MenuSeparator(),
        MenuItem("g-mi-delete", { icon: "x", label: t("common.delete"), danger: true, kbd: "⌘⌫" }),
      ] }),
    ];
  }

  empties() {
    return [
      Empty({ icon: "inbox", title: t("gallery.empty.title"), body: t("gallery.empty.body"), action: Button("g-empty-refresh", t("gallery.empty.refresh"), { icon: "refresh-cw", size: "sm" }) }),
      EmptySlot(t("gallery.empty.slot")),
    ];
  }

  spinners(k) {
    return [
      this.line([
        Spinner({ size: 14 }),
        Spinner({ size: 16, color: k.accent }),
        Spinner({ size: 16, color: k.text.tertiary }),
        h_flex().gap(8).items_center().child(Spinner({ label: t("common.loading") })).child(Text(t("common.loading"), { size: "sm", tone: "secondary" })),
      ], 18),
    ];
  }

  banners() {
    const dismiss = (key) => (_e, cx) => { this.dismissed.add(key); cx.notify(); };
    const all = [
      ["info", { title: t("gallery.banner.infoTitle"), body: t("gallery.banner.infoBody") }],
      ["warning", { title: t("gallery.banner.warnTitle"), body: t("gallery.banner.warnBody"), actions: [
        { id: "g-bn-restore", label: t("gallery.banner.restore"), variant: "primary" },
        { id: "g-bn-discard", label: t("gallery.banner.discard"), variant: "ghost" },
      ] }],
      ["error", { title: t("gallery.banner.errorTitle"), body: t("gallery.banner.errorBody"), actions: [
        { id: "g-bn-reload", label: t("gallery.banner.reload") },
        { id: "g-bn-overwrite", label: t("gallery.banner.overwrite"), variant: "ghost" },
      ] }],
      ["success", { title: t("gallery.banner.okTitle"), body: t("gallery.banner.okBody") }],
    ];
    const shown = all.filter(([tone]) => !this.dismissed.has(tone))
      .map(([tone, spec]) => Banner({ id: `g-banner-${tone}`, tone, ...spec, onDismiss: dismiss(tone), dismissLabel: t("common.close") }));
    if (this.dismissed.size) {
      shown.push(Button("g-bn-reset", t("gallery.banner.reset"), { variant: "ghost", size: "sm", icon: "rotate-ccw", onClick: (_e, cx) => { this.dismissed.clear(); cx.notify(); } }));
    }
    return shown;
  }

  checkboxes() {
    const toggle = (key) => (value, cx) => { this.checks[key] = value; cx.notify(); };
    return [
      CheckBox("g-cb-1", this.checks.one, toggle("one"), { label: t("gallery.check.one") }),
      CheckBox("g-cb-2", this.checks.two, toggle("two"), { label: t("gallery.check.two") }),
      this.line([
        this.labeled(t("gallery.state.focus"), CheckBox("g-cb-focus", false, () => {}, { label: t("gallery.check.three"), look: "focus" })),
        this.labeled(t("gallery.state.disabled"), CheckBox("g-cb-off", true, () => {}, { label: t("gallery.check.three"), disabled: true })),
      ], 18),
    ];
  }

  tooltips(k) {
    return [
      this.line([
        IconButton("g-tip-tree", "workflow", t("gallery.tooltip.button")),
        withTooltip(h_flex().id("g-tip-target").px(8).h(26).items_center().rounded(k.radius.md).border_1().border_dashed().border_color(k.line.strong)
          .child(Text(t("gallery.tooltip.target"), { size: "sm", tone: "secondary" })), t("gallery.tooltip.text")),
      ], 14),
    ];
  }

  click(cx) {
    this.clicks += 1;
    cx.notify();
  }

  render(_cx) {
    const k = tokens();
    const head = h_flex().flex_none().h(52).px(16).gap(10).items_center().border_b(1).border_color(k.line.soft).bg(k.bg.card)
      .child(Logo({ size: 20 }))
      .child(Text(t("gallery.title"), { size: "lg", weight: "semibold", nowrap: true }))
      .child(Badge(t(k.dark ? "gallery.appearance.dark" : "gallery.appearance.light"), { tone: "accent" }))
      .child(Text(t("gallery.subtitle"), { size: "sm", tone: "tertiary", truncate: true }).flex_1());
    const wide = 460 * 2 + 12;
    return ViewRoot("lz-gallery", { bg: k.bg.app })
      .child(head)
      .child(
        v_flex().id("lz-gallery-scroll").flex_1().min_h(0).overflow_y_scrollbar().child(
          h_flex().flex_wrap().items_start().gap(12).p(16)
            .child(this.section("colors", t("gallery.sec.colors"), this.colors(k), wide))
            .child(this.section("type", t("gallery.sec.type"), this.type(k), wide))
            .child(this.section("buttons", t("gallery.sec.buttons"), this.buttons()))
            .child(this.section("icon-buttons", t("gallery.sec.iconButtons"), this.iconButtons(k)))
            .child(this.section("rows", t("gallery.sec.rows"), this.rows(k)))
            .child(this.section("cards", t("gallery.sec.cards"), this.cards(k)))
            .child(this.section("fields", t("gallery.sec.fields"), this.fields()))
            .child(this.section("tabs", t("gallery.sec.tabs"), this.tabs()))
            .child(this.section("menu", t("gallery.sec.menu"), this.menu()))
            .child(this.section("banners", t("gallery.sec.banners"), this.banners()))
            .child(this.section("headers", t("gallery.sec.headers"), this.headers(k)))
            .child(this.section("status", t("gallery.sec.status"), this.status()))
            .child(this.section("counts", t("gallery.sec.counts"), this.counts(k)))
            .child(this.section("chips", t("gallery.sec.chips"), this.chips()))
            .child(this.section("kbd", t("gallery.sec.kbd"), this.kbds(k)))
            .child(this.section("marks", t("gallery.sec.marks"), this.marks(k)))
            .child(this.section("empty", t("gallery.sec.empty"), this.empties()))
            .child(this.section("spinner", t("gallery.sec.spinner"), this.spinners(k)))
            .child(this.section("checkbox", t("gallery.sec.checkbox"), this.checkboxes()))
            .child(this.section("tooltip", t("gallery.sec.tooltip"), this.tooltips(k)))
            .child(this.section("icons", t("gallery.sec.icons"), this.icons(k), wide)),
        ),
      );
  }
}
