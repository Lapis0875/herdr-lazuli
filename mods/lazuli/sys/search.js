// The palette's search index (ARCHITECTURE §4.4, DESIGN A4): lazuli's commands, Herdr's commands (with
// herdr-caffeinate's when that mod is installed, DESIGN D3), layouts, the language, spaces, tabs, agents, PRs from the
// gh store, to-dos, routines, and past sessions of OMP, Claude Code and Codex. `query(text)` ranks them; each result
// carries an action descriptor that `perform(action)` runs, so the palette view only draws and picks.
//
// Action descriptors (plain data):
//   {kind: "command" | "layout" | "place", run, args?, then?: [{run, args?}]}  → run(…) in order
//   {kind: "pr" | "todo" | "routine", app: "inbox" | "todo" | "routines", key}  → the app, on that row (as Home's links)
//   {kind: "language", value: "system" | "ko" | "en"}                          → the setting
//   {kind: "session", run: "tab.new", args: {folder?, argv}}  resume in a new tab; `alt` on the result forks instead

import { commands, keys, layouts, spaces, agents, home, run } from "herdr";
import { openApp } from "../views/apps/nav.js";
import * as store from "./store.js";
import { STORE, COMMANDS, MOD, LANGUAGE_SETTINGS } from "./state.js";
import { refreshSessions, findSessions, sessionsOf } from "./scan.js";
import * as caffeinate from "./caffeinate.js";
import { TOOLS, resumeArgv } from "../core/resume-tools.js";
import { forkArgv } from "../core/agent-cmd.js";
import { MOD as CAFFEINATE, commandKey } from "../core/caffeinate-chip.js";
import { t } from "../core/i18n.js";

/** Group codes in the order an empty query lists them; the palette words them with `palette.group.<code>`. */
export const GROUPS = Object.freeze(["lazuli", "places", "layout", "herdr", "language", "review", "mine", "merged", "todo", "routine", "session"]);

// Herdr's commands lazuli names itself: [command, args, catalog key]. The rest of commands() shows as Herdr names it.
const NAMED = [
  ["tab.new", {}, "tab-new"],
  ["tab.rename", {}, "tab-rename"],
  ["tab.close", {}, "tab-close"],
  ["tab.next", {}, "tab-next"],
  ["tab.prev", {}, "tab-prev"],
  ["pane.split", { direction: "right" }, "split-right"],
  ["pane.split", { direction: "down" }, "split-down"],
  ["pane.close", {}, "pane-close"],
  ["pane.zoom", {}, "pane-zoom"],
  ["space.new", {}, "space-new"],
  ["space.rename", {}, "space-rename"],
  ["space.close", {}, "space-close"],
  ["space.next", {}, "space-next"],
  ["space.prev", {}, "space-prev"],
  ["layout.switch", {}, "layout-next"],
  ["layout.reset", {}, "layout-reset"],
  ["terminal.open", {}, "terminal-open"],
  ["agent.next", {}, "agent-next"],
  ["agent.prev", {}, "agent-prev"],
  ["app.settings", {}, "app-settings"],
  ["app.help", {}, "app-help"],
  ["app.zoom_in", {}, "zoom-in"],
  ["app.zoom_out", {}, "zoom-out"],
  ["app.zoom_reset", {}, "zoom-reset"],
  ["app.quit", {}, "app-quit"],
];

// Commands that act on something pointed at (ids, terminals) or that lazuli lists itself: not for the list.
const HIDDEN = new Set([
  "space.move", "tab.move", "space.select", "tab.select", "pane.focus", "terminal.keep", "terminal.park", "terminal.kill",
  "terminal.show", "agent.focus", "layout.set", "layout.toggle", "layout.show", "layout.hide", "layout.resize",
  "layout.select", "layout.switch", "mod.open", "overlay.close", "tab.settle", "tab.unsettle", "app.palette", "app.hide",
  "app.hide_others", "app.show_all", "app.theme",
]);

// lazuli's commands not offered: the palette itself.
const UNLISTED = new Set(["palette"]);

const STATUS = new Set(["working", "blocked", "done", "idle"]);
const SHOW_WORK = Object.freeze({ run: "layout.select", args: { stack: "center", child: "work" } });
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" && v ? v : null);

const SEP = /[\s:.\-_/›#·]/;

/** Letters of `q` in order in `text`: a score (word starts and runs count more) and where they matched; null: none. */
function fuzzy(q, text) {
  const s = text.toLowerCase();
  let score = 0;
  let at = 0;
  let streak = 0;
  const hits = [];
  for (const ch of q) {
    const i = s.indexOf(ch, at);
    if (i < 0) return null;
    const start = i === 0 || SEP.test(s[i - 1]);
    streak = i === at && hits.length ? streak + 1 : 0;
    score += 1 + (start ? 6 : 0) + streak * 3 - Math.min(i - at, 6) * 0.3;
    hits.push(i);
    at = i + 1;
  }
  return { score: score - text.length * 0.02, hits };
}

/** How the typed text matches a title: tier 4 a whole word (or words), 3 a word's start, 2 inside a word, 1 only its
 *  letters in order; null: not at all. `phrase`: the text lower-cased with single spaces; `q`: the same without
 *  spaces, for the letters. `hits` are the matched title indexes; `score` orders matches within a tier. */
function titleMatch(phrase, q, text) {
  const s = text.toLowerCase();
  let best = null;
  for (let a = s.indexOf(phrase); a >= 0; a = s.indexOf(phrase, a + 1)) {
    const z = a + phrase.length;
    const start = a === 0 || SEP.test(s[a - 1]);
    const tier = start && (z === s.length || SEP.test(s[z])) ? 4 : start ? 3 : 2;
    if (!best || tier > best.tier) best = { tier, score: -text.length * 0.02, hits: Array.from({ length: phrase.length }, (_, i) => a + i) };
    if (tier === 4) break;
  }
  if (best) return best;
  const f = fuzzy(q, text);
  return f && { tier: 1, score: f.score, hits: f.hits };
}

/** Kinds whose titles are free text (sessions, PRs, to-dos): for equal match quality they rank after commands,
 *  settings, places and routines. */
const FREE = new Set(["session", "pr", "todo"]);

function shortPath(p) {
  if (!p) return "";
  const h = home();
  return p === h ? "~" : p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
}

/** The key bound to an action (`lazuli.recap`, `tab.new`, `pane.split:right`) in keys.json, or null. */
function bindings() {
  const out = new Map();
  for (const b of keys() ?? []) {
    if ((b.section === "global" || b.section === `layout:${MOD}`) && !out.has(b.action)) out.set(b.action, b.keys);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Sources. Each entry: {id, kind, group, icon, title, hint, status?, at?, keys?, words, action, alt?}.

function lazuliEntries(bound) {
  const out = [];
  for (const name of Object.keys(COMMANDS)) {
    if (UNLISTED.has(name)) continue;
    const action = `${MOD}.${name}`;
    out.push({ id: `cmd:${name}`, kind: "command", group: "lazuli", icon: "command", title: t(`palette.cmd.${name.replace(/:/g, ".")}`), hint: "", keys: bound.get(action) ?? null, words: name, action: { kind: "command", run: action } });
  }
  out.push({ id: "cmd:work", kind: "command", group: "lazuli", icon: "terminal", title: t("palette.cmd.work"), hint: "", keys: null, words: "work", action: { kind: "command", ...SHOW_WORK } });
  return out;
}

function herdrEntries(bound) {
  const out = [];
  const known = new Map((commands() ?? []).map((c) => [c.name, c]));
  for (const [name, args, k] of NAMED) {
    if (!known.has(name)) continue;
    const value = Object.values(args)[0];
    out.push({ id: `herdr:${name}:${value ?? ""}`, kind: "command", group: "herdr", icon: "command", title: t(`palette.herdr.${k}`), hint: "", keys: bound.get(value === undefined ? name : `${name}:${value}`) ?? null, words: name, action: { kind: "command", run: name, args } });
  }
  const named = new Set(NAMED.map(([n]) => n));
  for (const c of known.values()) {
    if (named.has(c.name) || HIDDEN.has(c.name) || c.args.some((a) => a.required)) continue;
    out.push({ id: `herdr:${c.name}:`, kind: "command", group: "herdr", icon: "command", title: c.name, hint: c.about ?? "", keys: bound.get(c.name) ?? null, words: c.name, action: { kind: "command", run: c.name, args: {} } });
  }
  for (const l of layouts() ?? []) {
    out.push({ id: `layout:${l}`, kind: "layout", group: "layout", icon: "layout", title: t("palette.layout", { name: l }), hint: "", keys: null, words: `layout ${l}`, action: { kind: "layout", run: "layout.switch", args: { name: l } } });
  }
  return out;
}

/** herdr-caffeinate's commands (its C1), listed with Herdr's and only while that mod is installed (sys/caffeinate.js),
 *  with the command glyph as every command row. The menu shows the key that opens the mod when no key names the
 *  command itself. */
function caffeinateEntries(bound) {
  return caffeinate.commands(Date.now()).map((cmd) => {
    const action = `${CAFFEINATE}.${cmd}`;
    const key = bound.get(action) ?? (cmd === "menu" ? bound.get(`mod.open:${CAFFEINATE}`) : null) ?? null;
    return { id: `caffeinate:${cmd}`, kind: "command", group: "herdr", icon: "command", title: t(`shell.caffeinate.cmd.${commandKey(cmd)}`), hint: CAFFEINATE, keys: key, words: `caffeinate ${cmd} awake sleep 잠자기 카페인`, action: { kind: "command", run: action } };
  });
}

function languageEntries() {
  return LANGUAGE_SETTINGS.map((value) => ({
    id: `language:${value}`, kind: "language", group: "language", icon: "languages", title: t(`palette.language.${value}`), hint: "",
    keys: null, words: "language 언어", action: { kind: "language", value },
  }));
}

function placeEntries() {
  const out = [];
  for (const s of spaces() ?? []) {
    out.push({ id: `space:${s.id}`, kind: "place", group: "places", icon: "folder", title: s.name, hint: s.branch ?? "", status: s.status, words: `space ${s.branch ?? ""}`, action: { kind: "place", run: "space.select", args: { id: s.id }, then: [SHOW_WORK] } });
    // Every tab is found by its name; a lone tab named as its space would only repeat the space's own entry.
    const tabs = s.tabs ?? [];
    for (const tab of tabs) {
      if (tabs.length === 1 && tab.name === s.name) continue;
      out.push({ id: `tab:${tab.id}`, kind: "place", group: "places", icon: "app-window", title: `${s.name} › ${tab.name}`, hint: "", status: tab.status, words: "tab", action: { kind: "place", run: "tab.select", args: { id: tab.id }, then: [SHOW_WORK] } });
    }
  }
  for (const a of agents() ?? []) {
    out.push({ id: `agent:${a.address}`, kind: "place", group: "places", icon: "bot", title: a.title || a.program?.name || a.address, hint: `${a.space_name} › ${a.tab_name}`, status: STATUS.has(a.status) ? a.status : undefined, words: `agent ${a.program?.name ?? ""}`, action: { kind: "place", run: "agent.focus", args: { terminal: a.address }, then: [SHOW_WORK] } });
  }
  return out;
}

function prEntries() {
  const gh = store.get(STORE.gh);
  if (!isObj(gh)) return [];
  const out = [];
  const seen = new Set();
  const add = (group, pr) => {
    if (!isObj(pr) || !str(pr.url) || seen.has(pr.url)) return;
    seen.add(pr.url);
    out.push({ id: `pr:${pr.url}`, kind: "pr", group, icon: "git-pull-request", title: `#${pr.number} ${pr.title ?? ""}`, hint: [pr.slug ?? pr.repo, pr.branch ?? pr.author].filter(Boolean).join(" · "), words: `pr ${pr.slug ?? ""} ${pr.author ?? ""}`, action: { kind: "pr", app: "inbox", key: pr.url } });
  };
  for (const pr of [...(gh.direct ?? []), ...(gh.team ?? [])]) add("review", pr);
  for (const pr of gh.mine ?? []) add("mine", pr);
  for (const pr of gh.merged ?? []) add("merged", pr);
  return out;
}

function todoEntries() {
  const v = store.get(STORE.todo);
  const items = Array.isArray(v?.items) ? v.items : [];
  return items
    .filter((i) => isObj(i) && str(i.text))
    .sort((a, b) => Number(a.done) - Number(b.done))
    .map((i) => ({ id: `todo:${i.key ?? i.text}`, kind: "todo", group: "todo", icon: i.done ? "circle-check" : "circle", title: i.undated ?? i.text, hint: "", words: "todo", action: { kind: "todo", app: "todo", key: i.key ?? i.text } }));
}

function routineEntries() {
  const v = store.get(STORE.routines);
  const list = Array.isArray(v) ? v : Array.isArray(v?.routines) ? v.routines : [];
  return list
    .filter((r) => isObj(r) && str(r.slug))
    .map((r) => ({ id: `routine:${r.slug}`, kind: "routine", group: "routine", icon: "clock", title: str(r.name) ?? r.slug, hint: str(r.whenText) ?? "", words: `routine ${r.slug}`, action: { kind: "routine", app: "routines", key: r.slug } }));
}

/** A past session's entry: Enter resumes it in a new tab in its folder; `alt` forks it there. OMP resumes by its
 *  file, the others by id. */
function sessionEntry(s) {
  const tool = TOOLS[s.tool];
  if (!tool) return null;
  const session = s.tool === "omp" ? s.path : s.id;
  const folder = str(s.cwd) ? { folder: s.cwd } : {};
  const fork = forkArgv(s.tool, [tool.bin], session);
  return {
    id: `session:${s.path}`, kind: "session", group: "session", icon: "message", title: s.title, hint: [tool.name, shortPath(s.cwd)].filter(Boolean).join(" · "),
    at: s.last ?? null, model: s.model ?? null, words: `${s.tool} ${s.cwd ?? ""}`,
    action: { kind: "session", run: "tab.new", args: { ...folder, argv: resumeArgv(s.tool, [tool.bin], session) } },
    ...(fork ? { alt: { kind: "session", run: "tab.new", args: { ...folder, argv: fork } } } : {}),
  };
}

// Sessions found for the typed text (scan.mjs sessions with a query), next to the newest 200 (scan.sessionsOf).
const found = { query: "", rows: [], asked: 0 };

function sessionEntries(q) {
  const newest = sessionsOf()?.sessions ?? [];
  const extra = q && found.query.toLowerCase().replace(/\s+/g, "") === q ? found.rows : [];
  const seen = new Set();
  const out = [];
  for (const s of [...newest, ...extra]) {
    if (!isObj(s) || !str(s.path) || seen.has(s.path)) continue;
    seen.add(s.path);
    const e = sessionEntry(s);
    if (e) out.push(e);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// The API.

/** Every entry, in group order. */
export function entries(q = "") {
  const bound = bindings();
  const all = [...lazuliEntries(bound), ...placeEntries(), ...herdrEntries(bound), ...caffeinateEntries(bound), ...languageEntries(), ...prEntries(), ...todoEntries(), ...routineEntries(), ...sessionEntries(q)];
  return all.sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group));
}

/**
 * Ranked results for the typed text, best first, at most `limit`. A title match ranks by its quality (a whole word,
 * a word's start, inside a word, letters in order; `positions` are the matched title indexes), then a close match in
 * the hint and keywords. For equal quality, commands, settings, places and routines come before sessions, PRs and
 * to-dos. An empty text lists the entries in group order without past sessions and to-dos beyond the first few.
 * Safe in render.
 */
export function query(text, { limit = 100 } = {}) {
  const phrase = String(text ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const q = phrase.replace(/ /g, "");
  const all = entries(q);
  if (!q) {
    const capped = { session: 10, todo: 10, merged: 10 };
    const shown = {};
    return all
      .filter((e) => (shown[e.group] = (shown[e.group] ?? 0) + 1) <= (capped[e.group] ?? Infinity))
      .slice(0, limit)
      .map((e) => ({ ...e, score: 0, positions: [] }));
  }
  const ranked = [];
  // Letters strewn across a text are noise: a keyword match must keep them close together, and so must a letters-in-
  // order title match in free text, where long titles hold almost any letters in order.
  const close = (m) => m && m.hits[m.hits.length - 1] - m.hits[0] < q.length * 3;
  for (const e of all) {
    const title = titleMatch(phrase, q, e.title);
    const usable = title && (title.tier > 1 || !FREE.has(e.kind) || close(title));
    const more = usable ? null : fuzzy(q, `${e.title} ${e.hint ?? ""} ${e.words ?? ""}`);
    const best = usable ? title : close(more) ? { tier: 0, score: more.score, hits: [] } : null;
    if (best) ranked.push({ ...e, tier: best.tier, score: best.score, positions: best.hits });
  }
  return ranked
    .sort((a, b) => b.tier - a.tier || FREE.has(a.kind) - FREE.has(b.kind) || b.score - a.score || GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || (b.at ?? 0) - (a.at ?? 0))
    .slice(0, limit);
}

/**
 * Keeps the asynchronous sources fresh while the palette is open: the newest sessions (at most once a minute) and,
 * for typed text of two characters or more, the sessions matching it beyond the newest 200. Redraws the asking copy
 * when they arrive. Call it when the palette opens and whenever its text changes.
 */
export function refresh(cx, text) {
  refreshSessions(cx);
  const q = String(text ?? "").trim();
  if (q.length < 2 || q === found.query) return;
  const asked = ++found.asked;
  cx.spawn(async (cx) => {
    let rows = [];
    try {
      rows = await findSessions(q, 50);
    } catch {}
    if (asked !== found.asked) return;
    Object.assign(found, { query: q, rows });
    cx.notify();
  });
}

/** Runs a result's action (or its `alt`). Resolves when a settings change is done. */
export async function perform(action) {
  if (!isObj(action)) return;
  if (action.kind === "language") {
    if (LANGUAGE_SETTINGS.includes(action.value)) await store.updateSettings((s) => ({ ...s, language: action.value }));
    return;
  }
  // A row of an app: its selection first, then the app, so it opens on that row (the Inbox's `o` opens a PR's page).
  if (str(action.app) && str(action.key)) {
    openApp(action.app, action.key);
    return;
  }
  if (str(action.run)) {
    if (action.args) run(action.run, action.args);
    else run(action.run);
  }
  for (const step of Array.isArray(action.then) ? action.then : []) if (str(step?.run)) run(step.run, step.args ?? {});
}
