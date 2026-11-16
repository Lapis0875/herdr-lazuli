// The hooks sync.mjs applies to the generated fork, after the mod-name rewrite (so anchors read
// `lstack-herdr-cockpit`, never `cockpit`). Each hook names one exact anchor that must appear exactly once in its file;
// a missing or repeated anchor fails the whole sync and the previous fork stays in place.
//   where: "before" | "after" the anchor, or "replace" it with `text`.

export const HOOKS = [
  // main.js: the views lstack-herdr adds, by props.app.
  {
    file: "main.js",
    anchor: 'import Mail from "./mail.js";',
    where: "after",
    text: '\nimport { LhTree, LhTreeWindow } from "./lh-tree-view.js";\nimport LhTranscript from "./lh-transcript.js";\nimport LhFiles from "./lh-files.js";',
  },
  {
    file: "main.js",
    anchor: "const VIEWS = { code: Code,",
    where: "replace",
    text: 'const VIEWS = { tree: LhTree, "tree-window": LhTreeWindow, transcript: LhTranscript, files: LhFiles, code: Code,',
  },

  // status.js: the tree is a side panel child (panel:tree toggles it), and the always-shown
  // status bar runs the tree's watcher and commands and the session-restore watcher (lh-resume.js).
  {
    file: "status.js",
    anchor: 'export const PANELS = { show: "show", review: "review", runbook: "runbook-panel", files: "files", changes: "changes" };',
    where: "replace",
    text: 'export const PANELS = { show: "show", review: "review", runbook: "runbook-panel", files: "files", changes: "changes", tree: "tree" };',
  },
  {
    file: "status.js",
    anchor: 'import { tokens, TEXT, RADIUS, Icon, Spinner, Mono, openMenu } from "./ui.js";',
    where: "after",
    text: '\nimport { lhWatch, lhCommand } from "./lh-watch.js";\nimport { lhResume } from "./lh-resume.js";',
  },
  {
    file: "status.js",
    anchor: "export default class Status {\n  init(_props, cx) {",
    where: "after",
    text: "\n    lhWatch(cx);\n    lhResume(cx);",
  },
  {
    file: "status.js",
    anchor: "  command(c, cx) {\n    const list = fleet(this.rows, this.home);",
    where: "replace",
    text: "  command(c, cx) {\n    if (lhCommand(c, cx)) return cx.notify();\n    const list = fleet(this.rows, this.home);",
  },

  // activity.js: the tree's button and its badge (running subagents; red with unseen failures).
  {
    file: "activity.js",
    anchor: '  { name: "changes", icon: "git-commit", label: "Changes", key: "⌃⌘5" },\n];',
    where: "replace",
    text: '  { name: "changes", icon: "git-commit", label: "Changes", key: "⌃⌘5" },\n  { name: "tree", icon: "workflow", label: "에이전트 호출 트리", key: "⌃⌘6" },\n];',
  },
  {
    file: "activity.js",
    anchor: 'import { findNode, PANELS } from "./status.js";',
    where: "after",
    text: '\nimport { lhTreeBadge } from "./lh-watch.js";',
  },
  {
    file: "activity.js",
    anchor: "      const badge = shared(`badge.${item.name}`);",
    where: "replace",
    text: '      const badge = item.name === "tree" ? lhTreeBadge() : shared(`badge.${item.name}`);',
  },

  // fleet.js: an agent whose subagents still run is working, whatever its own word (unless it needs you).
  {
    file: "fleet.js",
    anchor: 'import * as hub from "./hub.js";',
    where: "after",
    text: '\nimport { lhStage } from "./lh-home.js";',
  },
  {
    file: "fleet.js",
    anchor: "    agent.stage = stageOf(agent);",
    where: "replace",
    text: "    agent.stage = lhStage(agent, stageOf(agent));",
  },

  // home.js: a card's direct subagents, its failure badge, the timer of an idle root whose children run, and the
  // Home copy's own scan while Home shows (scan results are never shared state).
  {
    file: "home.js",
    anchor: 'import { fleet, goToAgent, agentAct } from "./fleet.js";',
    where: "after",
    text: '\nimport { lhCardKids, lhFailBadge, lhTimer, lhHomeWatch } from "./lh-home.js";',
  },
  {
    file: "home.js",
    anchor: "    this.flashes = new Flashes();",
    where: "after",
    text: "\n    lhHomeWatch(cx);",
  },
  {
    file: "home.js",
    anchor: "    const timer = !isAgentCard",
    where: "replace",
    text: "    let timer = !isAgentCard",
  },
  {
    file: "home.js",
    anchor: '    const title = isAgentCard ? a.title : pr?.title ?? "";',
    where: "before",
    text: "    timer = lhTimer(card, timer, this.now);\n",
  },
  {
    file: "home.js",
    anchor: '          .child(Mono(timer, { color: card.stage === "needs" ? tone : card.stage === "ready" ? k.success : k.mutedFg })),',
    where: "before",
    text: "          .children(lhFailBadge(card))\n",
  },
  {
    file: "home.js",
    anchor: '      .when(Boolean(recap), (e) => e.child(div().w_full().truncate().text_size(TEXT.sm).text_color(k.mutedFg).child(recap ?? "")))',
    where: "after",
    text: "\n      .children(lhCardKids(card, this))",
  },
];

/** The side panel's children upstream had when these hooks were written: a new one is reported, not lost. */
export const KNOWN_PANELS = ["show", "review", "runbook-panel", "files", "changes"];
