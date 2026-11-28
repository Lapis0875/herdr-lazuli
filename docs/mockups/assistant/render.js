// Draws one prototype screen from a state object (screens.js). Each function is one kit view or helper; the
// names follow the views U1 builds: frame → assistant row → assistant-list | assistant (chat) | side column with
// assistant-info above files (scope "assistant").

import { t, ft, L } from "./i18n.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const attr = (label) => `aria-label="${esc(label)}" title="${esc(label)}"`;

/* ---------- kit pieces ---------- */

export const icon = (name, cls = "") => `<svg class="i ${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const agentMark = (key) => `<svg class="am ${key === "omp" ? "omp" : ""}" aria-hidden="true"><use href="#agent-${key}"/></svg>`;
const spinner = (label, cls = "c-working") => `<svg class="i s13 spin ${cls}" role="img" ${label ? attr(label) : 'aria-hidden="true"'}><use href="#i-loader"/></svg>`;
const kbd = (k) => `<kbd>${esc(k)}</kbd>`;

/** kit IconButton: `label` is announced and shown as the tooltip. */
function ib(name, label, { size = "", on = false, disabled = false, cls = "", count, iconCls = "" } = {}) {
  return `<button class="ib ${size} ${on ? "on" : ""} ${cls}" ${attr(label)} ${disabled ? "disabled" : ""}>${icon(name, iconCls)}${count ? `<span class="count wait">${count}</span>` : ""}</button>`;
}

/** kit Button. */
function btn(label, { variant = "", ico, size = "", disabled = false, tip, kbd: k, cls = "", trail } = {}) {
  return `<button class="btn ${variant} ${size} ${cls}" ${disabled ? "disabled" : ""} ${tip ? `title="${esc(tip)}"` : ""}>${ico ? icon(ico) : ""}${esc(label)}${trail ? icon(trail, "s12") : ""}${k ? kbd(k) : ""}</button>`;
}

const BRIDGE = { off: "assistant.bridge.off", starting: "assistant.bridge.starting", ready: "assistant.bridge.ready", error: "assistant.bridge.error", stopped: "assistant.bridge.stopped" };

/** kit StatusDot for a bridge state; `starting` breathes. The label is the tooltip and what a screen reader says. */
function bridgeDot(state) {
  const label = t(BRIDGE[state]);
  return `<span class="gdot" ${attr(label)} role="img"><span class="dot ${state} ${state === "starting" ? "pulse" : ""}"></span></span>`;
}

/* ---------- frame (the lazuli layout around the center view) ---------- */

function sidebar(s) {
  const nav = [
    ["layout-dashboard", ft("shell.app.home"), kbd("⌥⌘0")],
    ["columns", ft("shell.app.work"), ""],
    ["inbox", ft("shell.app.inbox"), `<span class="count wait">4</span>`],
    ["list-todo", ft("shell.app.todo"), `<span class="count">3</span>`],
    ["calendar-clock", ft("shell.app.routines"), `<span class="run-dot pulse"></span>`],
  ];
  const b = s.badge ?? {};
  const asstTrail = b.waiting
    ? `<span class="count wait" ${attr(t("shell.nav.assistant", { running: b.running ?? 0, waiting: b.waiting }))}>${b.waiting}</span>`
    : b.running
      ? `<span class="run-dot pulse" ${attr(t("shell.nav.assistant", { running: b.running, waiting: 0 }))}></span>`
      : "";
  const rows = nav.map(([i, l, tr]) => `<span class="row">${icon(i)}<span class="lbl">${esc(l)}</span>${tr}</span>`).join("");
  const asst = `<span class="row sel" title="${esc(t("shell.app.assistant"))}  ⌥⌘4">${icon("bot")}<span class="lbl">${esc(t("shell.app.assistant"))}</span>${asstTrail}</span>`;
  const agents = L({
    ko: [["working", "omp", "미리보기 렌더러", "23분"], ["blocked", "claude", "Files 확인 문구", null], ["done", "codex", "i18n 키 테스트", "#47"]],
    en: [["working", "omp", "Preview renderer", "23m"], ["blocked", "claude", "Files confirm copy", null], ["done", "codex", "i18n key test", "#47"]],
  });
  const agentRows = agents.map(([st, m, title, meta]) => `<div class="agent"><span class="dot ${st}"></span>${agentMark(m)}<span class="t">${esc(title)}</span><span class="m ${meta ? "" : "wait"}">${esc(meta ?? ft("shell.sidebar.needsYou"))}</span></div>`).join("");
  return `<aside class="sidebar">
    <div class="lights" aria-hidden="true"><span></span><span></span><span></span></div>
    <div class="brand"><div class="name"><img src="../../../mods/lazuli/ui/logo.svg" alt="">lazuli</div>${ib("search", ft("shell.brand.search"))}${ib("sidebar", ft("shell.brand.fold"))}</div>
    <div class="sb-body">
      <div class="palette">${icon("command", "s13")}<span>${esc(ft("shell.sidebar.search"))}</span>${kbd("⇧⌘P")}</div>
      <nav class="nav" aria-label="${esc(ft("shell.app.home"))}">${rows}${asst}</nav>
      <div class="sec"><span>${esc(ft("shell.sidebar.spaces"))}</span>${icon("plus", "s13")}</div>
      <div class="machine">${icon("server", "s12")}${esc(ft("shell.sidebar.thisMac"))}</div>
      <div class="space">${icon("chevron-down")}<b>lazuli</b><span class="br">feat/assistant</span></div>
      ${agentRows}
      <div class="agent"><span class="dot idle"></span>${icon("terminal", "s13")}<span class="t">zsh</span></div>
      <div class="space">${icon("chevron-right")}<b>herdr-relay</b><span class="br">main</span><span class="dot done"></span></div>
    </div>
    <div class="sb-foot"><span>${icon("settings", "s13")}${esc(ft("shell.footer.settings"))}</span><span class="d">${icon("plus", "s13")}${esc(ft("shell.footer.addMachine"))}</span></div>
  </aside>`;
}

function topbar() {
  const tabs = L({
    ko: [["omp", "미리보기 렌더러"], ["claude", "Files 확인 문구"], ["codex", "i18n 키 테스트"]],
    en: [["omp", "Preview renderer"], ["claude", "Files confirm copy"], ["codex", "i18n key test"]],
  });
  return `<header class="topbar"><div class="tabs">${tabs.map(([m, l]) => `<div class="tab">${agentMark(m)}<span class="t">${esc(l)}</span></div>`).join("")}<span class="tab-add">${icon("plus", "s13")}</span></div><div class="bell">${icon("bell", "md")}</div></header>`;
}

function rail() {
  const items = [["git-pull-request", "shell.activity.review", "⌘1"], ["folder", "shell.activity.files", "⌘2"], ["file-diff", "shell.activity.changes", "⌘3"], ["workflow", "shell.activity.tree", "⌘4"], ["route", "shell.activity.plan", "⌘5"]];
  return `<nav class="rail card" aria-label="${esc(ft("shell.activity.label"))}">${items.map(([i, k, key]) => ib(i, `${ft(k)}  ${key}`)).join("")}</nav>`;
}

function statusbar() {
  const st = [["blocked", 1, "home.stage.needs"], ["working", 2, "home.stage.working"], ["done", 1, "home.stage.ready"], ["idle", 2, "home.stage.done"]];
  return `<footer class="status"><div class="grp">${st.map(([d, n, k]) => `<span class="st"><span class="dot ${d}"></span><b>${n}</b> ${esc(ft(k))}</span>`).join("")}</div><span class="vr"></span><div class="grp"><span class="st">${agentMark("omp")}omp · lazuli</span></div><span class="sp"></span><span class="st">${icon("send", "s13")}${esc(ft("shell.status.queued"))} <b>0</b> ${kbd("⌥⌘Q")}</span></footer>`;
}

export function frame(s, inner) {
  return `<div class="window">${sidebar(s)}<div class="main">${topbar()}<div class="center"><div class="asst">${inner}</div>${rail()}</div>${statusbar()}</div></div>`;
}

/* ---------- assistant-list ---------- */

function sessionRow(r) {
  const title = r.untitled ? t("assistant.list.untitled") : L(r.title);
  let lead = "";
  if (r.state === "running") lead = spinner(t("assistant.list.running", { count: 1 }));
  if (r.state === "waiting") lead = icon("hand", "s13 c-blocked");
  const det = r.hover
    ? ib("git-fork", t("assistant.list.fork"), { size: "xs" })
    : r.state === "waiting"
      ? `<span class="det wait">${esc(t("assistant.list.needsYou"))}</span>`
      : `<span class="det">${esc(L(r.time))}</span>`;
  const cls = [r.selected ? "sel" : "", r.hover ? "hover" : "", r.untitled ? "untitled" : ""].join(" ");
  return `<div class="row ${cls}" role="listitem" aria-selected="${Boolean(r.selected)}"><span class="lead">${lead}</span><span class="lbl">${esc(title)}</span>${det}</div>`;
}

function group(g) {
  if (g.planned) {
    return `<div class="gh planned" title="${esc(t("assistant.group.plannedHint"))}"><span class="tw"></span><span class="gname">${esc(g.name)}</span><span class="badge">${esc(t("assistant.group.planned"))}</span></div>`;
  }
  const collapsed = Boolean(g.collapsed);
  const tw = `<button class="tw" aria-expanded="${!collapsed}" ${attr(t(collapsed ? "assistant.list.expand" : "assistant.list.collapse", { profile: g.profile }))}>${icon(collapsed ? "chevron-right" : "chevron-down", "s12")}</button>`;
  const run = g.running ? `<span class="grun" ${attr(t("assistant.list.running", { count: g.running }))}>${spinner("")}${g.running}</span>` : "";
  const head = `<div class="gh" role="heading">${tw}<span class="gname">${esc(g.profile)}</span><span class="gagent">hermes</span><span class="gcount" ${attr(t("assistant.list.count", { count: g.rows.length + (g.more ?? 0) }))}>${g.rows.length + (g.more ?? 0)}</span><span class="sp"></span>${run}${bridgeDot(g.bridge)}${ib("plus", t("assistant.list.newIn", { profile: g.profile }), { size: "sm" })}</div>`;
  const err = g.bridge === "error" ? `<div class="gerr">${icon("circle-x", "s12")}<span class="trunc">${esc(t(g.error ?? "assistant.bridge.error"))}</span><button class="lnk">${esc(t("assistant.bridge.retry"))}</button></div>` : "";
  const rows = collapsed ? "" : g.rows.map(sessionRow).join("");
  return head + err + rows;
}

function pickerMenu(p) {
  // Every folder under ~/.hermes/profiles plus default (15 on this Mac); the list scrolls past nine rows.
  const profiles = ["default", "accessibility-auditor", "api-designer", "architect", "backend-engineer", "code-reviewer", "data-analyst", "debugger", "devops-engineer"];
  const items = profiles.map((name, i) => `<button class="mi ${i === 0 ? "sel" : ""}">${icon(i === 0 ? "bot" : "user")}<span class="lbl mono">${esc(name)}</span>${i === 0 ? `<span class="det">${esc(t("assistant.picker.default"))}</span>` : ""}</button>`).join("");
  return `<div class="menu" role="menu" aria-label="${esc(t("assistant.list.new"))}" style="left:${p.left ?? 8}px;top:${p.top ?? 36}px;width:252px">
    <div class="mfield">${icon("search", "s13")}<span>${esc(t("assistant.picker.filter"))}</span></div>
    <div class="ml">${esc(t("assistant.picker.label"))}<span class="sp"></span><span class="mono">15</span></div>
    <div class="mscroll">${items}<span class="thumb" style="top:2px;height:150px"></span></div>
    <div class="msep"></div>
    <div class="ml">${esc(t("assistant.picker.other"))}</div>
    <button class="mi" disabled title="${esc(t("assistant.group.plannedHint"))}">${icon("circle-dashed")}<span class="lbl">Nod</span><span class="badge">${esc(t("assistant.group.planned"))}</span></button>
  </div>`;
}

export function listBlock(s) {
  const head = `<div class="bh"><span class="ttl">${esc(t("assistant.list.title"))}</span><span class="sp"></span>${ib("message-square-plus", t("assistant.list.new"), { on: Boolean(s.picker), disabled: Boolean(s.gated) })}</div>`;
  let body;
  if (s.gated) body = `<div class="lempty">${esc(s.gated === "relay" ? t("assistant.gate.relay.short") : t("assistant.list.gated"))}</div>`;
  else body = `<div class="lbody" role="list">${s.groups.map(group).join("")}</div>`;
  return `<section class="blk list card" aria-label="${esc(t("assistant.list.title"))}">${head}${body}${s.picker ? pickerMenu(s.picker) : ""}</section>`;
}

/* ---------- assistant (chat) ---------- */

const KIND = {
  read: { icon: "file-text" }, edit: { icon: "file-diff" }, delete: { icon: "trash-2" }, move: { icon: "move-horizontal" },
  search: { icon: "search" }, execute: { icon: "terminal" }, think: { icon: "brain" }, fetch: { icon: "globe" },
  switch_mode: { icon: "layers" }, other: { icon: "wrench" },
};

function toolStatus(status, secs) {
  if (status === "completed") return `<span class="st c-success">${icon("circle-check", "s13")}${esc(t("assistant.tool.completed"))}</span>${secs ? `<span class="du">${esc(t("assistant.tool.seconds", { n: secs }))}</span>` : ""}`;
  if (status === "in_progress") return `<span class="st c-working">${spinner("")}${esc(t("assistant.tool.in_progress"))}</span>`;
  if (status === "failed") return `<span class="st c-error">${icon("circle-x", "s13")}${esc(t("assistant.tool.failed"))}</span>`;
  if (status === "waiting") return `<span class="st c-blocked">${icon("hand", "s13")}${esc(t("assistant.tool.waiting"))}</span>`;
  return `<span class="st t3">${icon("circle-dashed", "s13")}${esc(t("assistant.tool.pending"))}</span>`;
}

function diffView(d) {
  const lines = L(d.lines).map(([k, text]) => `<div class="dl ${k === "+" ? "add" : k === "-" ? "rem" : k === "@" ? "hunk" : ""}"><span class="sg">${k === "@" ? "" : esc(k === " " ? "" : k === "-" ? "−" : k)}</span>${esc(text)}</div>`).join("");
  return `<div class="diff"><div class="fh">${icon("file-diff", "s12")}<span class="p">${esc(d.path)}</span>${d.add ? `<span class="add">+${d.add}</span>` : ""}${d.remove ? `<span class="rem">−${d.remove}</span>` : ""}</div>${lines}</div>`;
}

function tool(it) {
  const open = Boolean(it.open);
  const title = L(it.title);
  const head = `<div class="hd">${icon(KIND[it.kind].icon)}<span class="tt">${it.mono ? `<span class="mono">${esc(title)}</span>` : esc(title)}</span>${toolStatus(it.status, it.secs)}<button class="tw" aria-expanded="${open}" ${attr(t(open ? "assistant.item.hide" : "assistant.item.show"))}>${icon(open ? "chevron-down" : "chevron-right", "s12")}</button></div>`;
  if (!open) return `<div class="tool ${it.status === "waiting" ? "waiting" : ""}">${head}</div>`;
  const parts = [];
  if (it.input) parts.push(`<div class="lab">${esc(t("assistant.tool.input"))}</div><div class="code">${esc(it.input)}</div>`);
  if (it.diff) parts.push(`<div class="lab">${esc(t("assistant.tool.changes"))}</div>${diffView(it.diff)}`);
  if (it.output) parts.push(`<div class="lab">${esc(t("assistant.tool.output"))}</div><div class="code">${esc(L(it.output))}${it.more ? `\n<span class="more">${esc(t("assistant.tool.more", { count: it.more }))}</span>` : ""}</div>`);
  return `<div class="tool">${head}<div class="bd">${parts.join("")}</div></div>`;
}

function thought(it) {
  const open = Boolean(it.open);
  const label = it.streaming ? t("assistant.thought.streaming") : t("assistant.thought");
  const text = L(it.text);
  const head = `<button class="hd" aria-expanded="${open}">${icon("brain", it.streaming ? "pulse" : "")}<b>${esc(label)}</b><span class="pv">${open ? "" : esc(text.split("\n")[0])}</span>${icon(open ? "chevron-down" : "chevron-right", "s12 t3")}</button>`;
  return `<div class="th">${head}${open ? `<div class="bd">${text.split("\n\n").map((p) => `<p>${esc(p)}</p>`).join("")}</div>` : ""}</div>`;
}

/** The session's plan (ChatState.plan, not a transcript item): docked above the composer, as the latest
 *  `plan` update left it. Collapsed it is one row with the entry in progress. */
function planDock(p) {
  const done = p.entries.filter((e) => e.status === "completed").length;
  const ico = { completed: "circle-check", in_progress: "circle-dot", pending: "circle" };
  const now = p.entries.find((e) => e.status === "in_progress") ?? p.entries.find((e) => e.status === "pending");
  const head = `<button class="hd" aria-expanded="${Boolean(p.open)}">${icon("list-todo")}<b>${esc(t("assistant.plan.title"))}</b><span class="t3 num">${esc(t("assistant.plan.progress", { done, total: p.entries.length }))}</span><span class="now">${p.open || !now ? "" : esc(L(now.text))}</span>${icon(p.open ? "chevron-down" : "chevron-up", "s12 t3")}</button>`;
  const list = p.open ? p.entries.map((e) => `<div class="pe ${e.status}">${icon(ico[e.status], e.status === "in_progress" ? "pulse" : "")}<span>${esc(L(e.text))}</span></div>`).join("") : "";
  return `<div class="plan">${head}${list}</div>`;
}

function user(it) {
  const tag = it.via === "steer" ? `<div class="tag">${icon("navigation", "s12")}${esc(t("assistant.user.steer"))}</div>` : it.via === "queue" ? `<div class="tag">${icon("list-ordered", "s12")}${esc(t("assistant.user.queued"))}</div>` : "";
  const atts = it.attachments?.length ? `<div class="atts">${it.attachments.map((a) => `<span class="chip mono">${icon("paperclip", "s12")}${esc(a)}</span>`).join("")}</div>` : "";
  return `<div class="u">${tag}<div>${esc(L(it.text))}</div>${atts}</div>`;
}

function agentText(it) {
  return `<div class="a" ${it.streaming ? 'aria-busy="true" aria-live="polite"' : ""}>${L(it.html)}${it.streaming ? '<span class="caret" aria-hidden="true"></span>' : ""}</div>`;
}

const OPTION_KEY = { allow_once: "assistant.approval.allowOnce", allow_always: "assistant.approval.allowAlways", allow_session: "assistant.approval.allowSession", deny: "assistant.approval.deny", deny_always: "assistant.approval.denyAlways" };
const BUTTON_IDS = ["allow_once", "allow_always", "deny"];

function approval(it) {
  const expired = it.state === "expired";
  const buttons = it.options.filter((o) => BUTTON_IDS.includes(o));
  const more = it.options.filter((o) => !BUTTON_IDS.includes(o));
  const label = (o) => t(OPTION_KEY[o]);
  const btns = buttons.map((o) => btn(label(o), { variant: o === "allow_once" ? "primary" : "", size: "sm", disabled: expired, ico: o === "deny" ? "x" : o === "allow_always" ? "shield-check" : "check" })).join("");
  const moreBtn = more.length ? `<span class="sp"></span>${btn(t("assistant.approval.more"), { variant: "ghost", size: "sm", disabled: expired, trail: "chevron-down", cls: it.menuOpen ? "on" : "" })}` : "";
  const head = expired
    ? `<div class="hd">${icon("hourglass")}<b class="trunc">${esc(it.edit ? t("assistant.approval.editTitle") : t("assistant.approval.title"))}</b><span class="sp"></span><span class="badge">${esc(t("assistant.approval.expired"))}</span></div>`
    : `<div class="hd">${icon("hand", "c-blocked")}<b class="trunc">${esc(it.edit ? t("assistant.approval.editTitle") : t("assistant.approval.title"))}</b><span class="sp"></span><span class="left">${icon("timer", "s12")}${esc(t("assistant.approval.left", { n: it.left }))}</span></div>`;
  const body = [];
  if (it.command) body.push(`<div class="code">${esc(it.command)}</div>`);
  if (it.diff) body.push(diffView(it.diff));
  if (it.why) body.push(`<div class="why">${esc(L(it.why))}</div>`);
  if (expired) body.push(`<div class="why">${esc(t("assistant.approval.expiredBody"))}</div>`);
  const pct = expired ? 0 : Math.round((it.left / 60) * 100);
  const menu = it.menuOpen
    ? `<div class="menu" role="menu" style="right:12px;top:calc(100% - 14px);width:220px">${more.map((o, i) => `<button class="mi ${i === 0 ? "sel" : ""} ${o.startsWith("deny") ? "danger" : ""}">${icon(o.startsWith("deny") ? "circle-x" : "shield-check")}<span class="lbl">${esc(label(o))}</span></button>`).join("")}</div>`
    : "";
  return `<div class="ap ${expired ? "expired" : ""}" role="group" aria-label="${esc(t("assistant.approval.title"))}">${head}${body.join("")}<div class="acts">${btns}${moreBtn}</div><div class="track" role="progressbar" aria-valuemin="0" aria-valuemax="60" aria-valuenow="${expired ? 0 : it.left}"><i style="width:${pct}%"></i></div>${menu}</div>`;
}

function event(it) {
  const spec = {
    steerSending: [spinner(""), "assistant.event.steerSending"],
    steerAck: [icon("navigation", "s13 c-accent"), "assistant.event.steerAck"],
    cancelled: [icon("circle-stop", "s13"), "assistant.event.cancelled"],
    tooLate: [icon("hourglass", "s13 c-blocked"), "assistant.event.tooLate"],
    failed: [icon("circle-x", "s13 c-error"), "assistant.event.failed"],
    modelSet: [icon("check", "s13"), "assistant.event.modelSet"],
  }[it.kind];
  return `<div class="ev" role="status">${spec[0]}<span>${esc(t(spec[1], it.vars ?? {}))}</span>${it.detail ? `<span class="d">${esc(it.detail)}</span>` : ""}</div>`;
}

const ITEM = { user, agent: agentText, thought, tool, approval, event };

function composer(c) {
  const running = Boolean(c.running);
  const chips = c.queue?.length
    ? `<div class="qrow">${c.paused ? `<span class="ql paused" title="${esc(t("assistant.queue.pausedHint"))}">${icon("circle-pause", "s12")}${esc(t("assistant.queue.paused"))}</span>` : `<span class="ql" title="${esc(t("assistant.queue.hint"))}">${icon("list-ordered", "s12")}${esc(t("assistant.queue.label", { count: c.queue.length }))}</span>`}${c.queue.map((q) => `<span class="qc ${c.paused ? "paused" : ""}"><span class="q">${esc(L(q))}</span>${ib("x", t("assistant.queue.remove"), { size: "xs", iconCls: "s12" })}</span>`).join("")}${c.paused ? `<span class="sp"></span>${btn(t("assistant.queue.resume"), { variant: "ghost", size: "sm", ico: "play" })}` : ""}</div>`
    : "";
  const atts = c.attachments?.length ? `<div class="arow">${c.attachments.map((a) => `<span class="att">${icon("paperclip", "s12")}${esc(a)}${ib("x", t("assistant.composer.removeAttachment", { name: a }), { size: "xs", iconCls: "s12" })}</span>`).join("")}</div>` : "";
  const raw = L(c.text);
  const text = raw
    ? `${esc(raw).replace(/(^|\s)([@/][\w./-]*)$/, '$1<span class="mention">$2</span>')}${c.focus ? '<span class="cur"></span>' : ""}`
    : `${c.focus ? '<span class="cur"></span>' : ""}<span class="ph">${esc(c.offline ? t("assistant.composer.offline") : running ? t("assistant.composer.placeholderRunning") : t("assistant.composer.placeholder"))}</span>`;
  const hint = running ? t("assistant.composer.hintRunning") : t("assistant.composer.hintIdle");
  const right = running
    ? `${btn(t("assistant.composer.stop"), { size: "sm", ico: "circle-stop", cls: "danger" })}${ib("arrow-up", t("assistant.composer.steer"), { cls: "solid", disabled: !c.text })}`
    : ib("arrow-up", t("assistant.composer.send"), { cls: "solid", disabled: c.offline || (!c.text && !c.attachments?.length) });
  const menu = c.menu === "mention" ? mentionMenu(c) : c.menu === "commands" ? commandsMenu(c) : "";
  return `<div class="cmp ${c.focus ? "focus" : ""} ${c.offline ? "off" : ""}" role="group" aria-label="${esc(t("assistant.composer.label"))}">${menu}${chips}${atts}<div class="ta" role="textbox" aria-multiline="true" aria-label="${esc(t("assistant.composer.label"))}">${text}</div><div class="tb">${ib("at-sign", `${t("assistant.composer.attach")}  @`, { size: "sm", disabled: c.offline })}${ib("square-slash", `${t("assistant.composer.commands")}  /`, { size: "sm", disabled: c.offline })}<span class="hint">${esc(hint)}</span><span class="sp"></span>${right}</div></div>`;
}

function mentionMenu(c) {
  const files = c.files;
  return `<div class="menu pop" role="listbox" aria-label="${esc(t("assistant.mention.label"))}"><div class="ml">${esc(t("assistant.mention.label"))}</div>${files.map(([dir, name], i) => `<div class="mi ${i === 0 ? "sel" : ""}" role="option" aria-selected="${i === 0}">${icon("file-text")}<span class="lbl">${esc(name)}</span><span class="p">${esc(dir)}</span></div>`).join("")}<div class="mfoot">${esc(t("assistant.mention.hint"))}</div></div>`;
}

function commandsMenu(c) {
  return `<div class="menu pop" role="listbox" aria-label="${esc(t("assistant.commands.label"))}" style="width:400px"><div class="ml">${esc(t("assistant.commands.label"))}</div>${c.commands.map(([name, desc], i) => `<div class="mi ${i === 0 ? "sel" : ""}" role="option" aria-selected="${i === 0}"><span class="cmd">/${esc(name)}</span><span class="ds">${esc(desc)}</span></div>`).join("")}<div class="mfoot">${esc(t("assistant.commands.hint"))}</div></div>`;
}

function banner(b) {
  return `<div class="banner" role="alert">${icon("circle-x", "md c-error")}<div class="txt"><b class="w5">${esc(t(b.title))}</b><span class="sm t2">${esc(t(b.body, b.vars ?? {}))}</span></div>${btn(t("assistant.banner.retry"), { size: "sm", ico: "refresh-cw" })}</div>`;
}

function gate(g) {
  const parts = [];
  const actions = (list) => `<div class="acts">${list.join("")}</div>`;
  if (g.kind === "no-folder") {
    parts.push(`<div class="disc">${icon("folder-open", "md")}</div><h2>${esc(t("assistant.gate.noFolder.title"))}</h2><p class="body">${esc(t("assistant.gate.noFolder.body"))}</p>`);
    parts.push(actions([btn(t("assistant.gate.noFolder.action"), { variant: "primary", ico: "folder-open" })]));
    parts.push(`<p class="hint">${esc(t("assistant.gate.noFolder.hint"))}</p>`);
  }
  if (g.kind === "folder-missing") {
    parts.push(`<div class="disc warn">${icon("folder-x", "md")}</div><h2>${esc(t("assistant.gate.missing.title"))}</h2><span class="path">${esc(g.path)}</span><p class="body">${esc(t("assistant.gate.missing.body"))}</p>`);
    parts.push(actions([btn(t("assistant.gate.retry"), { ico: "refresh-cw" }), btn(t("assistant.gate.missing.choose"), { variant: "primary", ico: "folder-open" })]));
  }
  if (g.kind === "hermes-missing") {
    parts.push(`<div class="disc warn">${icon("bot", "md")}</div><h2>${esc(t("assistant.gate.hermes.title"))}</h2><p class="body">${esc(t("assistant.gate.hermes.body"))}</p>`);
    parts.push(`<div class="step"><span class="lab">${esc(t("assistant.gate.hermes.install"))}</span><div class="cmdl"><span>curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash</span>${ib("copy", t("assistant.gate.copy"), { size: "sm" })}</div></div>`);
    parts.push(`<div class="step"><span class="lab">${esc(t("assistant.gate.hermes.setup"))}</span><div class="cmdl"><span>hermes setup</span>${ib("copy", t("assistant.gate.copy"), { size: "sm" })}</div></div>`);
    parts.push(actions([btn(t("assistant.gate.retry"), { variant: "primary", ico: "refresh-cw" })]));
    parts.push(`<p class="meta">${esc(t("assistant.gate.hermes.looked", { where: "PATH, ~/.local/bin/hermes" }))} · ${esc(t("assistant.gate.hermes.tested", { version: "0.17.0" }))}</p>`);
  }
  if (g.kind === "check-failed") {
    parts.push(`<div class="disc err">${icon("triangle-alert", "md")}</div><h2>${esc(t("assistant.gate.check.title"))}</h2><p class="body">${esc(t("assistant.gate.check.body"))}</p>`);
    parts.push(`<div class="step out"><span class="lab">${esc(t("assistant.gate.check.output", { code: 1 }))}</span><div class="code">${esc(g.output)}</div></div>`);
    parts.push(`<p class="hint">${esc(t("assistant.gate.check.hint"))}</p>`);
    parts.push(actions([btn(t("assistant.gate.retry"), { variant: "primary", ico: "refresh-cw" })]));
  }
  if (g.kind === "relay") {
    parts.push(`<div class="disc">${icon("laptop", "md")}</div><h2>${esc(t("assistant.gate.relay.title"))}</h2><p class="body">${esc(t("assistant.gate.relay.body"))}</p>`);
  }
  return `<div class="gate"><div class="gcard" role="${g.kind === "relay" || g.kind === "no-folder" ? "status" : "alert"}">${parts.join("")}</div></div>`;
}

function chatHeader(s) {
  if (s.gate) return `<div class="bh ch"><span class="ttl">${esc(t("shell.app.assistant"))}</span></div>`;
  const title = s.untitled ? t("assistant.list.untitled") : L(s.title);
  const run = s.running ? `<span class="runst">${spinner("")}${esc(t("assistant.chat.running", { time: s.running }))}</span>` : "";
  const model = btn(s.model, { size: "sm", variant: "ghost", cls: "model", trail: "chevron-down", disabled: Boolean(s.running), tip: s.running ? t("assistant.chat.modelBusy") : t("assistant.chat.model", { model: s.model }) });
  return `<div class="bh ch"><span class="ttl">${esc(title)}</span><span class="chip mono">${esc(s.profile)}</span><span class="sp"></span>${run}${model}${ib("git-fork", t("assistant.chat.fork"), { disabled: Boolean(s.running) || Boolean(s.empty) })}</div>`;
}

export function chatBlock(s) {
  let body = "";
  if (s.gate) body = gate(s.gate);
  else if (s.empty) {
    body = `<div class="empty"><div class="disc">${icon("bot", "md")}</div><div class="ttl">${esc(t("assistant.chat.emptyTitle", { profile: s.profile }))}</div><p class="body">${esc(t("assistant.chat.emptyBody", { folder: "~/Assistant" }))}</p></div>`;
  } else {
    const items = s.items.map((it) => ITEM[it.type](it)).join("");
    const thumb = s.thumb ? `<span class="thumb" style="bottom:${s.thumb[0]}px;height:${s.thumb[1]}px"></span>` : "";
    const menuOpen = s.items.some((it) => it.menuOpen);
    body = `<div class="tx ${s.stale ? "stale" : ""} ${menuOpen ? "menu-open" : ""}" role="log" aria-label="${esc(L(s.title))}">${items}${thumb}</div>`;
  }
  const banners = s.banner ? banner(s.banner) : "";
  const dock = !s.gate && s.plan ? planDock(s.plan) : "";
  const cmp = s.gate ? "" : composer(s.composer);
  return `<section class="blk chat card" aria-label="${esc(t("shell.app.assistant"))}">${chatHeader(s)}${banners}${body}${dock}${cmp}</section>`;
}

/* ---------- side column: assistant-info above files ---------- */

export function infoBlock(s) {
  const head = `<div class="bh"><span class="ttl">${esc(t("assistant.info.title"))}</span></div>`;
  if (!s.info) return `<section class="blk info card" aria-label="${esc(t("assistant.info.title"))}">${head}<div class="side-note">${esc(s.gated === "relay" ? t("assistant.gate.relay.short") : t("assistant.info.noSession"))}</div></section>`;
  const i = s.info;
  const none = `<span class="t3">${esc(t("assistant.info.none"))}</span>`;
  const unknown = `<span class="t3">${esc(t("assistant.info.unknown"))}</span>`;
  const kv = (k, v, mono = true) => `<div class="kv"><span class="k">${esc(t(k))}</span><span class="v ${mono ? "mono" : ""}">${v}</span></div>`;
  const ctx = i.context
    ? `<div class="kv"><span class="k">${esc(t("assistant.info.context"))}</span><span class="v mono">${esc(t("assistant.info.contextValue", i.context))}</span><span class="bar" role="meter" aria-label="${esc(t("assistant.info.context"))}" aria-valuenow="${i.context.pct}" aria-valuemin="0" aria-valuemax="100"><i style="width:${i.context.pct}%"></i></span></div>`
    : kv("assistant.info.context", none);
  const rows = [
    kv("assistant.info.model", esc(i.model)),
    kv("assistant.info.mode", esc(i.mode)),
    ctx,
    kv("assistant.info.lastTurn", i.last ? esc(t("assistant.info.lastTurnValue", i.last)) : none),
    kv("assistant.info.total", i.total ? esc(t("assistant.info.totalValue", i.total)) : none),
    kv("assistant.info.cost", i.cost === "unknown" ? unknown : i.cost ? `${esc(i.cost)} <span class="t3">${esc(t("assistant.info.costEstimated"))}</span>` : none),
  ];
  return `<section class="blk info card" aria-label="${esc(t("assistant.info.title"))}">${head}<div class="kvs">${rows.join("")}</div></section>`;
}

export function filesBlock(s) {
  const note = { none: t("assistant.files.none"), missing: t("assistant.gate.missing.title"), relay: t("assistant.gate.relay.short") }[s.files];
  const off = { disabled: Boolean(note) };
  const head = `<div class="bh"><span class="ttl" style="flex:1">${esc(ft("files.title"))}</span>${ib("file-plus", ft("files.new"), off)}${ib("folder-plus", ft("files.mkdir"), off)}${ib("chevrons-down-up", ft("files.collapse"), off)}</div>`;
  if (note) return `<section class="blk files card" aria-label="${esc(ft("files.title"))}">${head}<div class="side-note">${esc(note)}</div></section>`;
  const tree = s.tree.map(([depth, kind, name, mark, flags = ""]) => {
    const tw = kind === "dir" ? icon(flags.includes("open") ? "chevron-down" : "chevron-right", "s12") : "";
    const hover = flags.includes("hover");
    const act = hover ? ib("paperclip", t("assistant.files.attach"), { size: "xs", iconCls: "s12" }) : "";
    return `<div class="fr ${hover ? "hover" : ""} ${flags.includes("dim") ? "dim" : ""}" style="padding-left:${depth * 14}px" role="treeitem"><span class="tw">${tw}</span><span class="n">${esc(name)}</span>${act}${mark ? `<span class="g ${mark}" title="${esc(ft(`files.mark.${mark}`))}">${mark}</span>` : ""}</div>`;
  }).join("");
  return `<section class="blk files card" aria-label="${esc(ft("files.title"))}">${head}<div class="froot">${icon("folder")}<b>Assistant</b><span class="sp"></span><span class="pth">~/Assistant</span></div><div class="ftree" role="tree">${tree}</div></section>`;
}

export function screen(s) {
  const inner = `${listBlock(s)}${chatBlock(s)}<div class="side">${infoBlock(s)}${filesBlock(s)}</div>`;
  return frame(s, inner);
}
