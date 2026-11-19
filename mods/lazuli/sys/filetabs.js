// File tabs (DESIGN B1, B2, B10, B11; ARCHITECTURE §6): opening a file as a center tab (dedupe per
// space, the space's reused preview tab, pinning), the registry in shared("lazuli.tabs") by fid, a
// copy finding its own tab at render (spike S6), the dirty marker, open tabs following a renamed file
// or folder (with their drafts), pruning entries whose tab is gone (the status copy calls
// startFileTabs), and the quick-open dialog with its file list.
//
// Module state (shared by every copy, F3): which fids have unsaved edits, line requests for open tabs,
// and the recent renames.

import * as fs from "fs/promises";
import { createHash, randomUUID } from "crypto";
import { checking, exec, focused, home, machines, openOverlay, panes, run, setShared, shared, spaces } from "herdr";
import { KEY, MOD } from "./state.js";
import { handle } from "./bus.js";
import { dataDir, debugLog } from "./store.js";
import { bind, claim, openPlan, pin as pinEntry, setMode as setModeEntry, sweep } from "../core/tabs-reg.js";
import { dirname, fileKey, normalize, tabName } from "../core/paths.js";
import { draftFile, makeDraft, parseDraft } from "../core/drafts.js";
import { rank } from "../core/fuzzy.js";

const log = (msg) => console.log(`[lazuli/filetabs] ${msg}`);
const errText = (e) => e?.message ?? String(e);
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** The status copy prunes the registry this often. */
export const SWEEP_MS = 10000;
/** Quick open lists at most this many files (B11). */
export const QUICK_OPEN_MAX = 20000;
/** Quick open shows this many matches. */
export const QUICK_OPEN_SHOWN = 50;
/** A preview tab with no tab id yet is still taken as the space's preview tab this long after its
 *  last open (its copy finds its tab within a tick of being shown). */
export const PENDING_PREVIEW_MS = 10000;

/** sha1 of a text as hex (C7: core takes hashes as arguments). */
export function sha1(text) {
  return String(createHash("sha1").update(text).digest("hex"));
}

/** The first 8 characters of a fid: the HTML viewer's title is `lazuli-view:<fid8>` (§5). */
export const fid8 = (fid) => String(fid).slice(0, 8);

// The registry.

/** The registry: `{[fid]: {file, on, preview, mode, space, tab, pane, at}}`. */
export function registry() {
  const r = shared(KEY.tabs);
  return isPlain(r) ? r : {};
}

/** One entry, or null. */
export function entryOf(fid) {
  const e = registry()[fid];
  return isPlain(e) && typeof e.file === "string" ? e : null;
}

function save(reg) {
  setShared(KEY.tabs, reg);
}

/** Runs a Herdr command; false (logged) when it is refused, e.g. on a relay device (D4). */
function act(name, args) {
  try {
    run(name, args);
    return true;
  } catch (e) {
    log(`${name} failed: ${errText(e)}`);
    return false;
  }
}

const dirty = new Set();
const lines = new Map();

/** Whether the tab has unsaved edits (as its model reported). */
export const isDirty = (fid) => dirty.has(fid);

function rename(fid) {
  // Checked again from the copy's tick, also when the tab has no id yet (applied once it binds).
  nameChecks.set(fid, NAME_CHECKS);
  const e = entryOf(fid);
  if (!e?.tab) return;
  act("tab.rename", { id: e.tab, name: tabName(e.file, { preview: e.preview === true, dirty: dirty.has(fid) }) });
}

/** Makes a preview tab a normal one (a double click, B2): registry and name. False when it was not one. */
export function pin(fid) {
  const reg = registry();
  if (!isPlain(reg[fid]) || reg[fid].preview !== true) return false;
  save(pinEntry(reg, fid));
  rename(fid);
  return true;
}

/** The model reports unsaved edits. Only a change acts: the "● " marker comes or goes with tab.rename,
 *  and the first edit pins a preview tab (B2). */
export function setDirty(fid, value) {
  const now = value === true;
  if (now === dirty.has(fid)) return;
  if (now) dirty.add(fid);
  else dirty.delete(fid);
  const reg = registry();
  if (now && isPlain(reg[fid]) && reg[fid].preview === true) save(pinEntry(reg, fid));
  rename(fid);
}

/** The mode the tab wants, kept in the registry (null: the kind's default). */
export function setMode(fid, mode) {
  const reg = registry();
  if (!isPlain(reg[fid]) || reg[fid].mode === mode) return;
  save(setModeEntry(reg, fid, mode));
}

/** A line the tab should show, asked by an open() since its copy last looked; null when none. */
export function takeLine(fid) {
  const line = lines.get(fid) ?? null;
  lines.delete(fid);
  return line;
}

/** Corrects the tab's name from the registry once its tab is known: a "●" left from before a restart,
 *  a renamed file, a pin or retarget that came while the tab had no id yet (its preview flag and file
 *  were recorded on the entry then; the name follows here). True when the tab already shows the right
 *  name; false when it is not found yet or was renamed just now (call again to confirm: a name given
 *  by tab.new can land after this rename). */
export function syncName(fid) {
  const e = entryOf(fid);
  if (!e?.tab) return false;
  const tab = spaces()
    .flatMap((s) => s.tabs ?? [])
    .find((t) => t.id === e.tab);
  if (!tab) return false;
  const want = tabName(e.file, { preview: e.preview === true, dirty: dirty.has(fid) });
  if (tab.name === want) return true;
  act("tab.rename", { id: e.tab, name: want });
  return false;
}

/** A copy's state is gone (its close()); the registry entry stays for a restart and is pruned with
 *  its tab. */
export function forget(fid) {
  dirty.delete(fid);
  lines.delete(fid);
  unresolved.delete(fid);
  nameChecks.delete(fid);
}

// Tab names due a check: fid → checks left once the tab's id is known. Every rename (a pin, a dirty
// marker, a retarget, a file rename) and every new copy sets it, so a change made while the tab had no
// id yet, or a name tab.new gives after ours, ends with the registry's name.
const NAME_CHECKS = 5;
const nameChecks = new Map();

/** The copy's tick: while its name is due a check, the tab gets the registry's name and is looked at
 *  again until it holds, at most NAME_CHECKS ticks after its id is known (a name the person gives the
 *  tab later is left alone). */
export function tickName(fid) {
  if (!nameChecks.has(fid)) return;
  if (syncName(fid)) {
    nameChecks.delete(fid);
    return;
  }
  if (!entryOf(fid)?.tab) return;
  const left = nameChecks.get(fid) - 1;
  if (left > 0) nameChecks.set(fid, left);
  else nameChecks.delete(fid);
}

// Live file copies whose own tab is not known yet (resolveOwn outside render needs it).
const unresolved = new Set();

/** A file copy started (its model's constructor): its tab is looked for (resolveOwn) and its name
 *  checked (tickName). */
export function copyStarted(fid) {
  if (typeof fid !== "string" || fid === "") return;
  unresolved.add(fid);
  nameChecks.set(fid, NAME_CHECKS);
}

// Renames (the Files panel calls renamed() after a rename succeeds).

/** Renames kept for copies that look later (a hidden tab's copy looks on its next tick). */
const RENAMES_KEPT = 100;
const renames = [];
let renameCount = 0;
let draftMoves = Promise.resolve();

/** `file` after `from` became `to`: `to` for `from` itself, the same tail under `to` for a path under
 *  `from`, else null. */
function moved(file, from, to) {
  if (file === from) return to;
  return file.startsWith(`${from}/`) ? `${to}${file.slice(from.length)}` : null;
}

/** `<app home>/data/lazuli/drafts`. */
export const draftDir = () => `${dataDir()}/drafts`;

// Drafts (B5) belong to one buffer: the same file open in two spaces is two tabs, two buffers, two
// drafts. A draft file is `<sha1 of fileKey>.<owner>.json`, owner the first 16 hex of sha1(fid) (fids
// outlive restarts in the registry). `<sha1 of fileKey>.json` is a draft from before owners. A draft
// offered on open is set aside as `<sha1>.<owner>.<at>.offered.json` until the person restores or
// discards it, so the buffer's own autosave never writes over it.
const DRAFT_NAME = /^([0-9a-f]{40})(?:\.([0-9a-f]{16}))?(?:\.(\d+)\.offered)?\.json$/;
const ownerTag = (fid) => sha1(String(fid)).slice(0, 16);

/** The draft file of one tab's buffer of a file. */
export function draftPathOf(file, on, fid) {
  return draftFile(draftDir(), `${sha1(fileKey(file, on || null))}.${ownerTag(fid)}`);
}

/** Where a draft of one tab's buffer is set aside while it is offered (`at`: the draft's time). */
export function asidePathOf(file, on, fid, at) {
  return draftFile(draftDir(), `${sha1(fileKey(file, on || null))}.${ownerTag(fid)}.${Math.max(0, Math.floor(Number(at) || 0))}.offered`);
}

/** A complete temp copy left when it could not replace its draft: `<draft>.part-<8 hex>`. */
const PART = /^(.+\.json)\.part-[0-9a-f]{8}$/;
// The temp copy this module left beside each draft path (the newest one only).
const keptParts = new Map();

/** Writes a draft whole or not at all: a temp file beside it, then `mv` over it (Herdr's fs has no
 *  rename). The draft is never written in place: when `mv` fails, the previous draft stays as it was
 *  and the complete temp copy stays too (listDrafts takes it as the newest copy of that draft); the
 *  failure is logged and thrown. */
export async function writeAtomic(path, text) {
  const tmp = `${path}.part-${randomUUID().slice(0, 8)}`;
  await fs.writeFile(tmp, text);
  let why = null;
  try {
    const r = await exec("mv", ["-f", tmp, path], { timeout: 10000 });
    if (r.code !== 0) why = r.stderr.trim() || `mv exited ${r.code}`;
  } catch (e) {
    why = errText(e);
  }
  const before = keptParts.get(path);
  if (why === null) {
    keptParts.delete(path);
    if (before) await fs.unlink(before).catch(() => {});
    return;
  }
  keptParts.set(path, tmp);
  if (before && before !== tmp) await fs.unlink(before).catch(() => {});
  log(`draft not replaced, kept beside it: ${path}: ${why}`);
  debugLog("filetabs", `draft not replaced, kept beside it: ${path}: ${why}`);
  throw new Error(`not replaced: ${why}`);
}

/** Deletes a draft and the temp copy this module left beside it. */
export async function removeDraft(path) {
  const part = keptParts.get(path);
  keptParts.delete(path);
  await fs.unlink(path).catch(() => {});
  if (part) await fs.unlink(part).catch(() => {});
}

/** The same owner's draft file (set aside or not) for another file (a rename), or null for a path
 *  that is no draft. */
export function rekeyDraft(path, file, on) {
  const m = DRAFT_NAME.exec(String(path).slice(String(path).lastIndexOf("/") + 1));
  if (!m) return null;
  const key = sha1(fileKey(file, on || null));
  return draftFile(draftDir(), `${key}${m[2] ? `.${m[2]}` : ""}${m[3] !== undefined ? `.${m[3]}.offered` : ""}`);
}

/** The drafts of a file that one tab may be offered, as `{path, draft}`:
 *  - `own`: this tab's draft (null when none);
 *  - `aside`: this tab's drafts set aside earlier and never decided on, newest first;
 *  - `orphans`: drafts (set aside or not) of tabs that no longer exist (their fid left the registry
 *    or their tab left spaces()), and drafts from before owners, newest first.
 *  A draft of another tab that still exists, or one not opened yet, is never listed. */
export async function listDrafts(file, on, fid) {
  const dir = draftDir();
  const key = sha1(fileKey(file, on || null));
  const mine = ownerTag(fid);
  const tabs = tabSpaces();
  const live = new Set(
    Object.entries(registry())
      .filter(([k, e]) => k !== fid && isPlain(e) && (!e.tab || tabs.has(e.tab)))
      .map(([k]) => ownerTag(k)),
  );
  const out = { own: null, aside: [], orphans: [] };
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return out;
  }
  // Every complete copy of one draft (the draft and temp copies left beside it): the newest wins and
  // the older ones go; a temp copy that does not parse (cut short) is no draft.
  const copies = new Map();
  for (const name of names) {
    const base = PART.exec(name)?.[1] ?? name;
    const m = DRAFT_NAME.exec(base);
    if (!m || m[1] !== key || (m[2] && m[2] !== mine && live.has(m[2]))) continue;
    const path = `${dir}/${name}`;
    const draft = parseDraft(await fs.readFile(path, "utf8").catch(() => null));
    if (!draft) continue;
    if (!copies.has(base)) copies.set(base, []);
    copies.get(base).push({ path, draft, part: name !== base });
  }
  for (const [base, list] of copies) {
    list.sort((a, b) => b.draft.at - a.draft.at || Number(a.part) - Number(b.part));
    const [best, ...older] = list;
    for (const o of older) await fs.unlink(o.path).catch(() => {});
    const m = DRAFT_NAME.exec(base);
    const found = { path: best.path, draft: best.draft };
    if (m[2] !== mine) out.orphans.push(found);
    else if (m[3] === undefined) out.own = found;
    else out.aside.push(found);
  }
  const newest = (a, b) => b.draft.at - a.draft.at;
  out.aside.sort(newest);
  out.orphans.sort(newest);
  return out;
}

/** A file or folder was renamed: every open tab on that machine whose file is `oldAbs` or under it
 *  now names the same file at `newAbs` (fid, mode, preview and unsaved edits kept), its tab name
 *  follows (markers kept), and drafts move with their files. Live copies pick it up from the registry
 *  (file/model.js keeps their buffers). Returns how many entries changed. */
export function renamed(oldAbs, newAbs, { on = null } = {}) {
  const from = normalize(oldAbs);
  const to = normalize(newAbs);
  if (!from.startsWith("/") || !to.startsWith("/") || from === "/" || from === to) return 0;
  const machine = on || null;
  renames.push({ seq: ++renameCount, on: machine, from, to });
  if (renames.length > RENAMES_KEPT) renames.shift();
  const reg = registry();
  const next = { ...reg };
  const changed = [];
  for (const [fid, e] of Object.entries(reg)) {
    if (!isPlain(e) || typeof e.file !== "string" || (e.on || null) !== machine) continue;
    const file = moved(normalize(e.file), from, to);
    if (file === null || file === e.file) continue;
    next[fid] = { ...e, file };
    changed.push(fid);
  }
  if (changed.length) {
    save(next);
    for (const fid of changed) rename(fid);
  }
  moveDrafts(from, to, { on: machine });
  return changed.length;
}

/** The count of renames so far: a copy notes it once it follows its file. */
export const renameSeq = () => renameCount;

/** Where `file` is after the renames since `since` (a renameSeq() value): `{path, seq}`. */
export function followRenames(file, on, since) {
  let path = file;
  for (const r of renames) {
    if (r.seq > since && r.on === (on || null)) path = moved(path, r.from, r.to) ?? path;
  }
  return { path, seq: renameCount };
}

/** Rewrites the drafts of files at or under `from` for their place under `to` (a draft names its
 *  file), each keeping its owner; a newer draft already there wins. One move at a time; resolves when
 *  this one is done. */
export function moveDrafts(from, to, { on = null } = {}) {
  if (checking()) return Promise.resolve();
  const job = draftMoves.then(() => moveDraftsNow(normalize(from), normalize(to), on || null));
  draftMoves = job.catch((e) => log(`drafts not moved: ${errText(e)}`));
  return draftMoves;
}

async function moveDraftsNow(from, to, on) {
  const dir = draftDir();
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const base = PART.exec(name)?.[1] ?? name;
    if (!DRAFT_NAME.test(base)) continue;
    const path = `${dir}/${name}`;
    const d = parseDraft(await fs.readFile(path, "utf8").catch(() => null));
    if (!d || (d.on || null) !== on) continue;
    const file = moved(normalize(d.file), from, to);
    if (file === null) continue;
    const target = rekeyDraft(`${dir}/${base}`, file, on);
    if (!target || target === path) continue;
    const there = (await fs.exists(target)) ? parseDraft(await fs.readFile(target, "utf8").catch(() => null)) : null;
    // A failed replacement throws before the source goes (a complete copy is left beside the target).
    if (!there || there.at < d.at) await writeAtomic(target, JSON.stringify(makeDraft({ file, on, baseHash: d.baseHash, text: d.text, now: d.at })));
    await fs.unlink(path).catch(() => {});
  }
}

// Where files open.

/** The focused pane's place: `{space, cwd, on, pane, file}`. On a file tab, its file's folder and
 *  machine (`file` set); else the pane's live folder (else the space's folder, else home) and the
 *  space's machine. */
export function context() {
  const f = focused();
  const all = spaces();
  const space = all.find((s) => s.id === f?.space) ?? all.find((s) => s.active) ?? null;
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) ?? null : null;
  if (pane?.mod === MOD) {
    const hit = Object.values(registry()).find((e) => isPlain(e) && e.pane === pane.pane && typeof e.file === "string");
    if (hit) return { space: space?.id ?? null, cwd: dirname(hit.file), on: hit.on || null, pane: pane.pane, file: hit.file };
  }
  const on = f && !f.pane && typeof f.terminal === "string" && f.terminal.includes("/") ? f.terminal.slice(0, f.terminal.indexOf("/")) : space?.machine ?? null;
  const cwd = pane?.cwd || f?.cwd || space?.folder || (on ? null : home());
  return { space: space?.id ?? null, cwd: cwd || null, on, pane: pane?.pane ?? null, file: null };
}

/** Opens a file as a center tab (B1, B2): `o.preview` (default true: a single click) reuses the
 *  space's preview tab; `o.pin` (or preview false: a double click, ⌘Enter) makes a normal tab or pins
 *  the open one; `o.line` asks the tab to show that line; `o.mode` the mode it opens in. The space
 *  is `o.space`, else the focused one; the machine `o.on`, else the space's. A file already open in
 *  the space gets its tab selected. Returns `{action, fid}`, or null when nothing opened. */
export function open(file, o = {}) {
  if (typeof file !== "string" || file === "") return null;
  const space = o.space ?? context().space;
  if (!space) return null;
  const on = o.on !== undefined ? o.on || null : spaces().find((s) => s.id === space)?.machine ?? null;
  const pinned = o.pin === true || o.preview === false;
  const mode = typeof o.mode === "string" ? o.mode : null;
  const line = Number.isInteger(o.line) && o.line > 0 ? o.line : null;
  const reg = dropClosed(registry());
  // A preview tab opened moments ago has no tab id until its copy finds it; it is retargeted all the
  // same (by fid: the copy loads the registry's file and fixes its tab name once it finds its tab),
  // so two quick clicks give one preview tab. One unbound for longer may never have opened: not reused.
  const now = Date.now();
  const stale = Object.keys(reg).filter((fid) => isPlain(reg[fid]) && reg[fid].preview === true && !reg[fid].tab && !(now - (reg[fid].at ?? 0) < PENDING_PREVIEW_MS));
  const plan = openPlan(reg, { file: normalize(file), on, space, pin: pinned, fid: randomUUID(), now, dirty: [...dirty, ...stale] });
  if (plan.action === "select") {
    if (pinned) pin(plan.fid);
    if (mode) setMode(plan.fid, mode);
    if (line) lines.set(plan.fid, line);
    const tab = entryOf(plan.fid)?.tab;
    if (tab) act("tab.select", { id: tab });
    return { action: "select", fid: plan.fid };
  }
  const next = mode ? setModeEntry(plan.reg, plan.fid, mode) : plan.reg;
  if (plan.action === "retarget") {
    const tab = next[plan.fid].tab;
    save(next);
    if (line) lines.set(plan.fid, line);
    else lines.delete(plan.fid);
    nameChecks.set(plan.fid, NAME_CHECKS);
    if (tab) {
      act("tab.rename", { id: tab, name: plan.name });
      act("tab.select", { id: tab });
    }
    return { action: "retarget", fid: plan.fid };
  }
  save(next);
  const props = { ...plan.props, ...(mode ? { mode } : {}), ...(line ? { line } : {}) };
  if (!act("tab.new", { space, mod: MOD, name: plan.name, focus: true, props })) {
    const { [plan.fid]: _gone, ...rest } = registry();
    save(rest);
    return null;
  }
  return { action: "new", fid: plan.fid };
}

// A copy's own tab (S6): never resolved in init (focus is the previous tab there), only at render.

function tabSpaces() {
  const out = new Map();
  for (const s of spaces()) for (const t of s.tabs ?? []) out.set(t.id, s.id);
  return out;
}

/** The file copy's `{space, tab, pane}`, and its registry entry kept current. The registry's ids win
 *  while that tab still holds a lazuli pane. A candidate tab is taken only when no other fid holds it
 *  and it has a lazuli pane no other fid holds, so two entries never share a tab.
 *  - At render (`o.render`, the default) the copy is shown (only shown copies render, S6), so its tab
 *    is the shown space's active tab, else the focused tab, else the only lazuli pane in the window
 *    with no entry.
 *  - From the model's tick (`render: false`; timers run while Herdr draws no frame) the copy may be
 *    hidden, so only certain cases count, and only for a copy with no tab yet: the only lazuli pane
 *    with no entry, or, while this is the only live file copy without a tab, the shown active tab
 *    when its one lazuli pane is free. A tab gone from an entry is left to render and pruning.
 *  A missing entry (a tab opened with tab.new and props only, or one pruned) is written from
 *  `fallback` (`{file, on, preview, mode}`) with the ids. Null until it resolves. Writes shared state
 *  only on a change. */
export function resolveOwn(fid, fallback, o = {}) {
  if (typeof fid !== "string" || fid === "") return null;
  const render = o.render !== false;
  const reg = registry();
  const e = isPlain(reg[fid]) ? reg[fid] : null;
  const where = tabSpaces();
  const all = panes().filter((p) => p.mod === MOD);
  let ids = null;
  if (e?.tab && where.has(e.tab)) {
    const mine = all.filter((p) => p.tab === e.tab);
    const pane = mine.find((p) => p.pane === e.pane) ?? (mine.length === 1 ? mine[0] : null);
    if (pane) ids = { space: where.get(e.tab), tab: e.tab, pane: pane.pane };
  }
  if (!ids) {
    if (!render && e?.tab) return null;
    const others = Object.entries(reg).filter(([k, v]) => k !== fid && isPlain(v));
    const heldPanes = new Set(others.filter(([, v]) => v.pane).map(([, v]) => v.pane));
    const free = all.filter((p) => !heldPanes.has(p.pane) && where.has(p.tab) && claim(reg, fid, [p.tab]) === p.tab);
    const shown = spaces()
      .filter((s) => s.active)
      .flatMap((s) => (s.tabs ?? []).filter((t) => t.active).map((t) => t.id));
    const candidates = [];
    if (render) candidates.push(...shown, focused()?.tab ?? null);
    if (free.length === 1) candidates.push(free[0].tab);
    if (!render && unresolved.size === 1 && unresolved.has(fid)) {
      candidates.push(...shown.filter((tab) => all.filter((p) => p.tab === tab).length === 1));
    }
    for (const tab of candidates) {
      const pane = tab ? free.find((p) => p.tab === tab) : null;
      if (pane) {
        ids = { space: where.get(tab), tab, pane: pane.pane };
        break;
      }
    }
    if (!ids) return null;
  }
  if (!e) {
    if (typeof fallback?.file === "string" && fallback.file !== "") {
      const mode = typeof fallback.mode === "string" ? fallback.mode : null;
      const entry = { file: normalize(fallback.file), on: fallback.on || null, preview: fallback.preview === true, mode, ...ids, at: Date.now() };
      save({ ...reg, [fid]: entry });
    }
  } else if (e.space !== ids.space || e.tab !== ids.tab || e.pane !== ids.pane) {
    save(bind(reg, fid, ids));
  }
  unresolved.delete(fid);
  return ids;
}

// Pruning (the status copy).

let misses = {};

const machineOf = (e) => (typeof e?.space === "string" && e.space.includes("/") ? e.space.slice(0, e.space.indexOf("/")) : "");

/** The registry without entries whose tab was closed (bound to a tab no longer in spaces() on a
 *  machine whose layout is ready), saved when that drops any. Opening a file just after its tab
 *  closed then opens a new tab instead of selecting the closed one (pruning takes two ticks). */
function dropClosed(reg) {
  const ready = new Set(machines().filter((m) => m.layout === "ready").map((m) => m.name ?? ""));
  const tabs = tabSpaces();
  const next = {};
  let dropped = false;
  for (const [fid, e] of Object.entries(reg)) {
    if (isPlain(e) && e.tab && !tabs.has(e.tab) && ready.has(machineOf(e)) && !dirty.has(fid)) {
      dropped = true;
      continue;
    }
    next[fid] = e;
  }
  if (dropped) save(next);
  return dropped ? next : reg;
}

/** One pruning tick: entries whose tab is gone from spaces() on two ticks in a row are dropped, but
 *  only for machines whose layout is ready (a loading machine lists no tabs yet). */
export function pruneTick(now = Date.now()) {
  const ready = new Set(machines().filter((m) => m.layout === "ready").map((m) => m.name ?? ""));
  const reg = registry();
  const checked = {};
  for (const [fid, e] of Object.entries(reg)) if (ready.has(machineOf(e))) checked[fid] = e;
  const r = sweep(checked, [...tabSpaces().keys()], misses, now);
  const next = {};
  const kept = {};
  for (const [fid, e] of Object.entries(reg)) {
    if (!Object.prototype.hasOwnProperty.call(checked, fid)) {
      next[fid] = e;
      if (typeof misses[fid] === "number") kept[fid] = misses[fid];
    } else if (Object.prototype.hasOwnProperty.call(r.reg, fid)) next[fid] = e;
  }
  misses = { ...kept, ...r.misses };
  if (Object.keys(next).length !== Object.keys(reg).length) save(next);
}

/** Starts registry pruning; the `status` copy calls it once in init. Returns the timer task. */
export function startFileTabs(cx) {
  if (checking()) return null;
  return cx.timer.every(SWEEP_MS, () => {
    try {
      pruneTick();
    } catch (e) {
      log(`prune failed: ${errText(e)}`);
    }
  });
}

// Quick open (B11).

// $1 root ("" = home), $2 most lines, $3 "1" to widen to the repository's top level. Prints the
// source ("git" or "find") and the root it listed, then one path per line.
const LIST_SCRIPT = [
  'r=${1:-$HOME}; max=$2',
  'if git -C "$r" rev-parse --is-inside-work-tree >/dev/null 2>&1; then',
  '  if [ "$3" = 1 ]; then t=$(git -C "$r" rev-parse --show-toplevel 2>/dev/null) && [ -n "$t" ] && r=$t; fi',
  '  printf "git\\n%s\\n" "$r"',
  '  git -c core.quotepath=off -C "$r" ls-files --cached --others --exclude-standard | head -n "$max"',
  "else",
  '  printf "find\\n%s\\n" "$r"',
  '  find "$r" -maxdepth 6 \\( -name .git -o -name node_modules \\) -prune -o -type f -print 2>/dev/null | head -n "$max"',
  "fi",
].join("\n");

const C_ESCAPES = { a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r", '"': '"', "\\": "\\" };

/** A path as git prints it: C-quoted when it holds control characters, quotes or backslashes. */
function unquote(line) {
  if (line.length < 2 || line[0] !== '"' || line[line.length - 1] !== '"') return line;
  const body = line.slice(1, -1);
  let out = "";
  // Octal escapes are UTF-8 bytes: a run of them is decoded together.
  let bytes = "";
  const flush = () => {
    if (!bytes) return;
    try {
      out += decodeURIComponent(bytes);
    } catch {
      out += bytes.split("%").filter(Boolean).map((h) => String.fromCharCode(parseInt(h, 16))).join("");
    }
    bytes = "";
  };
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    const n = body[i + 1] ?? "";
    if (c === "\\" && /^[0-7]{3}$/.test(body.slice(i + 1, i + 4))) {
      bytes += `%${parseInt(body.slice(i + 1, i + 4), 8).toString(16).padStart(2, "0")}`;
      i += 3;
      continue;
    }
    flush();
    if (c === "\\") {
      out += Object.prototype.hasOwnProperty.call(C_ESCAPES, n) ? C_ESCAPES[n] : n;
      i += 1;
    } else out += c;
  }
  flush();
  return out;
}

/** The files under `root` for quick open: `git ls-files --cached --others --exclude-standard` in a
 *  repository, else `find` to depth 6 (no .git, node_modules); at most QUICK_OPEN_MAX, relative to
 *  the root listed. `o.widen`: a repository's top level instead of `root` (quick open from a file
 *  tab). Resolves `{root, on, source, files, truncated}` or `{error: "unreadable", detail}`. */
export async function listFiles(root, o = {}) {
  const on = o.on || null;
  let r;
  try {
    r = await exec("sh", ["-c", LIST_SCRIPT, "lazuli", root || "", String(QUICK_OPEN_MAX + 1), o.widen ? "1" : "0"], { on, timeout: 20000 });
  } catch (e) {
    return { error: "unreadable", detail: errText(e) };
  }
  const out = r.stdout.split("\n");
  const source = out[0];
  if (source !== "git" && source !== "find") return { error: "unreadable", detail: r.stderr.trim() };
  const base = out[1] || root || "";
  const prefix = base.endsWith("/") ? base : `${base}/`;
  const files = [];
  const seen = new Set();
  for (const line of out.slice(2)) {
    if (line === "") continue;
    let path = source === "git" ? unquote(line) : line;
    if (source === "find") path = path.startsWith(prefix) ? path.slice(prefix.length) : path;
    if (path === "" || seen.has(path)) continue;
    seen.add(path);
    files.push(path);
  }
  const truncated = files.length > QUICK_OPEN_MAX;
  return { root: base, on, source, files: truncated ? files.slice(0, QUICK_OPEN_MAX) : files, truncated };
}

/** The best matches of `query` in a listFiles result (core/fuzzy.js), each with its absolute path:
 *  `{path, abs, score, positions}`; positions index `path`. */
export function search(list, query, limit = QUICK_OPEN_SHOWN) {
  if (!list || !Array.isArray(list.files)) return [];
  const prefix = list.root.endsWith("/") ? list.root : `${list.root}/`;
  return rank(typeof query === "string" ? query.trim() : "", list.files, limit).map((m) => ({ ...m, abs: `${prefix}${m.path}` }));
}

/** ⌘⇧O: the quick-open dialog over the focused place. Its props carry what it lists: `root`, `on`,
 *  `space` (where Enter opens), `widen` (from a file tab: the repository's top level). */
export function openQuickOpen() {
  const c = context();
  try {
    return openOverlay({
      mod: MOD,
      kind: "dialog",
      width: 640,
      height: 460,
      props: { view: "quickopen", root: c.cwd, on: c.on, space: c.space, widen: c.file !== null },
    });
  } catch (e) {
    log(`quick open failed: ${errText(e)}`);
    return null;
  }
}

handle("quickopen", () => {
  openQuickOpen();
});
