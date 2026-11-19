// The To-do service (ARCHITECTURE §4.5): data/lazuli/todo.md read into the `todo` store (and its snapshot), and the
// edits the To-do views make. Like cockpit v0.38.5 `todo/src/gui.rs`, an edit names items by their text, reads the
// file fresh, and can be undone while nobody else wrote the file since. lazuli writes with writeTextFile(path, text,
// previous): a stale write reads the file again and applies the edit once more. Undo keeps the last 20 edits in memory.
//
// Items are named by key. A text alone names the one item with that text. Several items with one text are told apart
// by which of them it is: the key `"<nth>/<count>\n<text>"` (a line never holds "\n", so no text looks like one) or
// `{text, nth, count?}`, `nth` counting from 0 in file order among the `count` items with that text. The store gives
// every item its key: the text when it is the only one, the long form otherwise.
//
// Every edit resolves with `{note}` or `{error}`, codes the views name through the catalog:
//   notes  "added" "toggled" "deleted" "undone" "nothing-to-add" "nothing-to-undo" "changed-since" ""
//   errors "not-found" (no item with that text) "ambiguous" (a text alone, and several items hold it) "changed" (the
//          items with that text are no longer the ones the key counted: reread and pick again) "only-open" (a done
//          item cannot move) "read-failed" "write-failed" "stale" (the file changed underneath twice)
//
// The store value: {version: 1, path, exists, items: [{key, nth, line, done, text, undated, doneOn, links}], open,
// done, canUndo, repo, error}. `key` is what the edits take; `links` resolve `#n` against `repo`, the GitHub repository of
// the shown space's folder (read with git). The `status` copy calls start(cx) in init and stop() in close (a layout
// switch closes it); views read get() in render and call the edits from their handlers.

import * as fs from "fs/promises";
import { checking, exec, focused, readTextFile, spaces, watchFolder, writeTextFile } from "herdr";
import * as todo from "../core/todo-doc.js";
import { STORE } from "./state.js";
import * as store from "./store.js";
import { migrated } from "./migrate.js";

const log = (msg) => console.log(`[lazuli/todo] ${msg}`);
const errText = (e) => e?.message ?? String(e);

const UNDO_DEPTH = 20;
const TICK_MS = 3000;
/** Reads the file again every this many ticks while the folder watch works, every tick when it does not. */
const POLL_TICKS = 4;
const REPO_TTL_MS = 60000;
const GIT_TIMEOUT_MS = 5000;

const EDGES = /^\p{White_Space}+|\p{White_Space}+$/gu;
const GITHUB = /github\.com[:/]+([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/;

/** `<app home>/data/lazuli/todo.md`. */
export const todoPath = () => `${store.dataDir()}/todo.md`;

// What the file held when last read or written: text null = absent.
let last = { text: null, error: null };
let published = null;
const undos = [];
// `key`, `slug`, `at`: the last answer (key: the space asked about, null when none was shown); `asking` and `token`:
// the lookup under way (a newer token voids it); `shown`: the repository `#n` uses now.
const repo = { key: undefined, slug: null, at: 0, asking: undefined, token: 0, shown: null };
let started = false;
let watching = false;
let ticks = 0;
// What start() set going, for stop(): the watch loop's task, the timer, the pending folder watch, and the start they
// belong to (a loop of an earlier start ends at its next wake-up).
let generation = 0;
let tasks = [];
let pending = null;

// One read or edit at a time, in call order, none before the migration settled: it copies cockpit's todo.md only
// while data/lazuli/todo.md is absent (§7).
let chain = null;
function serial(fn) {
  chain ??= Promise.resolve().then(migrated).catch(() => {});
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

const blank = (text) => text.replace(EDGES, "") === "";
const oneLine = (text) => (typeof text === "string" ? text.replace(/[\r\n]+/g, " ").replace(EDGES, "") : "");
const keyList = (keys) => (Array.isArray(keys) ? keys : keys === undefined || keys === null ? [] : [keys]);
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const LONG_KEY = /^(\d+)\/(\d+)\n(.*)$/s;

/** The key of the `nth` of `count` items holding `text`. */
export const keyOf = (text, nth = 0, count = 1) => (count === 1 ? text : `${nth}/${count}\n${text}`);

/** A key → `{text, nth?, count?}`, or null. */
function parseKey(key) {
  if (typeof key === "string") {
    const found = LONG_KEY.exec(key);
    return found ? { text: found[3], nth: Number(found[1]), count: Number(found[2]) } : { text: key };
  }
  if (!isPlain(key) || typeof key.text !== "string") return null;
  const n = (v) => (Number.isInteger(v) && v >= 0 ? v : undefined);
  return { text: key.text, nth: n(key.nth), count: n(key.count) };
}

/** The item a key names in this doc → `{item}` or `{error: "not-found" | "ambiguous" | "changed"}`. */
function find(doc, key) {
  const want = parseKey(key);
  if (!want) return { error: "not-found" };
  const same = todo.items(doc).filter((i) => i.text === want.text);
  if (same.length === 0) return { error: "not-found" };
  if (want.nth === undefined) return same.length === 1 ? { item: same[0] } : { error: "ambiguous" };
  if (want.nth >= same.length || (want.count !== undefined && want.count !== same.length)) return { error: "changed" };
  return { item: same[want.nth] };
}

/** The lines several keys name, in their order, each once → `{lines}` or the first `{error}`. */
function findAll(doc, keys) {
  const lines = [];
  for (const key of keyList(keys)) {
    const r = find(doc, key);
    if (r.error) return r;
    if (!lines.includes(r.item.line)) lines.push(r.item.line);
  }
  return { lines };
}

/** Where each item line goes when the item on `line` toggles: toggle() is set(), then order()'s stable open-first
 *  partition over the lines the items take. */
function toggleMoves(doc, line) {
  const list = todo.items(doc).map((i) => (i.line === line ? { ...i, done: !i.done } : i));
  const slots = list.map((i) => i.line);
  const moves = new Map();
  [...list.filter((i) => !i.done), ...list.filter((i) => i.done)].forEach((item, k) => moves.set(item.line, slots[k]));
  return moves;
}
const openLines = (doc) => todo.items(doc).filter((i) => !i.done).map((i) => i.line);

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** The date in an item's " (done YYYY-MM-DD)", or null. */
function doneOn(text, plain) {
  const rest = text.slice(plain.length).replace(EDGES, "");
  return rest.startsWith("(done ") && rest.endsWith(")") ? rest.slice(6, -1) : null;
}

// The store.

const canUndoNow = () => undos.length > 0 && undos[undos.length - 1].after === (last.text ?? "");

function model() {
  const items = todo.items(todo.parse(last.text ?? ""));
  const counts = new Map();
  for (const i of items) counts.set(i.text, (counts.get(i.text) ?? 0) + 1);
  const seen = new Map();
  const list = items.map((i) => {
    const nth = seen.get(i.text) ?? 0;
    seen.set(i.text, nth + 1);
    const plain = todo.undated(i.text);
    return {
      key: keyOf(i.text, nth, counts.get(i.text)),
      nth,
      line: i.line,
      done: i.done,
      text: i.text,
      undated: plain,
      doneOn: doneOn(i.text, plain),
      links: todo.links(i.text, { repo: repo.shown ?? undefined }),
    };
  });
  const open = list.filter((i) => !i.done).length;
  return { version: 1, path: todoPath(), exists: last.text !== null, items: list, open, done: list.length - open, canUndo: canUndoNow(), repo: repo.shown, error: last.error };
}

/** Sets the store when what it shows changed. */
function publish() {
  const sig = JSON.stringify([last.text, last.error, canUndoNow(), repo.shown]);
  if (sig === published && store.has(STORE.todo)) return;
  published = sig;
  store.set(STORE.todo, model());
}

function remember(text) {
  last = { text, error: null };
  publish();
}

async function readNow() {
  try {
    remember(await readTextFile(todoPath()));
  } catch (e) {
    log(`not read: ${errText(e)}`);
    last = { ...last, error: "read-failed" };
    publish();
  }
  return store.get(STORE.todo);
}

/** The list as the views draw it (the store value), or null before the first read and with no snapshot. */
export function get() {
  return store.get(STORE.todo) ?? null;
}

/** Whether undo() would undo something. */
export function canUndo() {
  return canUndoNow();
}

/** The GitHub repository ("owner/name") `#n` refers to now, or null. */
export function currentRepo() {
  return repo.shown;
}

/** The links in a text, `#n` resolved against the shown space's repository (todo-doc.js `links`). */
export function links(text) {
  return todo.links(text, { repo: repo.shown ?? undefined });
}

/** Reads the file again into the store. Resolves with the store value. */
export function reload() {
  return serial(readNow);
}

// Edits.

/** One edit of the file read fresh: `edit(doc)` → `{doc, note}` or `{error}`. Written only when the text changes;
 *  remembered for undo. */
async function change(edit) {
  const path = todoPath();
  for (let attempt = 0; ; attempt++) {
    let before;
    try {
      before = await readTextFile(path);
    } catch (e) {
      log(`not read: ${errText(e)}`);
      return { error: "read-failed" };
    }
    const base = before ?? "";
    const doc = todo.items(todo.parse(base)).length === 0 && blank(base) ? todo.parse(todo.NEW_FILE) : todo.parse(base);
    const r = edit(doc);
    if (r.error) {
      remember(before);
      return { error: r.error };
    }
    const after = todo.text(r.doc);
    if (after === base) {
      remember(before);
      return { note: r.note };
    }
    try {
      await fs.mkdir(store.dataDir(), { recursive: true });
      await writeTextFile(path, after, before);
    } catch (e) {
      let now;
      try {
        now = await readTextFile(path);
      } catch {
        now = before;
      }
      if (now === before) {
        log(`not written: ${errText(e)}`);
        return { error: "write-failed" };
      }
      remember(now);
      if (attempt === 0) continue;
      return { error: "stale" };
    }
    undos.push({ before: base, after });
    if (undos.length > UNDO_DEPTH) undos.shift();
    remember(after);
    return { note: r.note };
  }
}

// Two lines trade places.
function swap(doc, a, b) {
  if (a === b) return doc;
  const [lo, hi] = a < b ? [a, b] : [b, a];
  return todo.place(todo.place(doc, lo, hi), hi - 1, lo);
}

/** A new open item on top. Newlines become spaces; empty → note "nothing-to-add". */
export function add(text) {
  const clean = oneLine(text);
  if (clean === "") return Promise.resolve({ note: "nothing-to-add" });
  return serial(() => change((doc) => ({ doc: todo.add(doc, clean), note: "added" })));
}

/** The item a key names renamed to `to` (done or open as it was). An empty `to` changes nothing. */
export function edit(key, to) {
  const clean = oneLine(to);
  return serial(() =>
    change((doc) => {
      const r = find(doc, key);
      if (r.error) return r;
      const item = r.item;
      return { doc: clean !== "" && clean !== item.text ? todo.set(doc, item.line, item.done, clean) : doc, note: "" };
    }),
  );
}

/** Items (one key or a list of keys) done, or open again, dated today. */
export function toggle(keys) {
  const date = today();
  return serial(() =>
    change((doc) => {
      const r = findAll(doc, keys);
      if (r.error) return r;
      let next = doc;
      let lines = r.lines;
      // Last first: each one done goes on top of the done ones, so they keep their order. The lines still to toggle
      // follow the moves each toggle makes.
      for (let k = lines.length - 1; k >= 0; k--) {
        const moves = toggleMoves(next, lines[k]);
        next = todo.toggle(next, lines[k], date);
        lines = lines.map((line) => moves.get(line) ?? line);
      }
      return { doc: next, note: r.lines.length > 1 ? "toggled" : "" };
    }),
  );
}

/** Items (one key or a list of keys) deleted. */
export function remove(keys) {
  return serial(() =>
    change((doc) => {
      const r = findAll(doc, keys);
      if (r.error) return r;
      let next = doc;
      for (const line of [...r.lines].sort((a, b) => b - a)) next = todo.remove(next, line);
      return { doc: next, note: "deleted" };
    }),
  );
}

/** An open item `by` places up (negative) or down among the open ones; past either end it stays. */
export function move(key, by) {
  const step = Number.isInteger(by) ? by : 0;
  return serial(() =>
    change((doc) => {
      const r = find(doc, key);
      if (r.error) return r;
      const open = openLines(doc);
      const at = open.indexOf(r.item.line);
      if (at < 0) return { error: "only-open" };
      const target = at + step;
      return { doc: target >= 0 && target < open.length ? swap(doc, r.item.line, open[target]) : doc, note: "" };
    }),
  );
}

/** An open item put at index `to` among the open ones (a drag); past the end means last. */
export function place(key, to) {
  const index = Number.isInteger(to) && to >= 0 ? to : 0;
  return serial(() =>
    change((doc) => {
      const r = find(doc, key);
      if (r.error) return r;
      const open = openLines(doc);
      if (!open.includes(r.item.line)) return { error: "only-open" };
      return { doc: todo.place(doc, r.item.line, open[Math.min(index, open.length - 1)]), note: "" };
    }),
  );
}

/** The last edit undone, unless the file changed since it was written (then nothing is left to undo). */
export function undo() {
  return serial(async () => {
    const path = todoPath();
    let now;
    try {
      now = await readTextFile(path);
    } catch (e) {
      log(`not read: ${errText(e)}`);
      return { error: "read-failed" };
    }
    const top = undos[undos.length - 1];
    if (!top) {
      remember(now);
      return { note: "nothing-to-undo" };
    }
    if (top.after !== (now ?? "")) {
      // Undoing past another writer's change would drop it.
      undos.length = 0;
      remember(now);
      return { note: "changed-since" };
    }
    try {
      await writeTextFile(path, top.before, now);
    } catch (e) {
      let after;
      try {
        after = await readTextFile(path);
      } catch {
        after = now;
      }
      if (after === now) {
        log(`undo not written: ${errText(e)}`);
        return { error: "write-failed" };
      }
      undos.length = 0;
      remember(after);
      return { note: "changed-since" };
    }
    undos.pop();
    remember(top.before);
    return { note: "undone" };
  });
}

// The shown space's repository, for `#n`.

function slugOf(remotes) {
  const rows = remotes
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((row) => row.length >= 2 && GITHUB.test(row[1]));
  const pick = rows.find((row) => row[0] === "origin") ?? rows[0];
  const found = pick ? GITHUB.exec(pick[1]) : null;
  return found ? `${found[1]}/${found[2]}` : null;
}

function show(slug) {
  if (slug === repo.shown) return;
  repo.shown = slug;
  publish();
}

/** The shown space and the folder `#n` reads the repository of: `{space, folder, key}`, key null when there is none. */
function shownSpace() {
  const space = spaces().find((s) => s.active) ?? null;
  const folder = space?.folder || focused()?.cwd || null;
  return { space, folder, key: space && folder ? `${space.machine ?? ""}\n${folder}` : null };
}

async function refreshRepo() {
  const { space, folder, key } = shownSpace();
  if (key === repo.key && Date.now() - repo.at < REPO_TTL_MS) {
    // The shown space's answer is known: a lookup for any other space no longer counts.
    repo.token += 1;
    repo.asking = undefined;
    show(repo.slug);
    return;
  }
  if (repo.asking === key) return;
  const token = ++repo.token;
  repo.asking = key;
  // Another space: no `#n` links until its repository is known.
  if (key !== repo.key) show(null);
  let slug = null;
  if (key !== null) {
    try {
      const r = await exec("git", ["-C", folder, "remote", "-v"], { on: space.machine, timeout: GIT_TIMEOUT_MS });
      if (r.code === 0) slug = slugOf(r.stdout);
    } catch (e) {
      log(`git remote failed in ${folder}: ${errText(e)}`);
    }
  }
  // A newer call voided this lookup; or the space changed after it started and no call saw it yet: the answer is not
  // the shown space's (the next call asks again).
  if (token !== repo.token) return;
  repo.asking = undefined;
  if (shownSpace().key !== key) return;
  repo.key = key;
  repo.slug = slug;
  repo.at = Date.now();
  show(slug);
}

// Reading the file again when it changes.

async function watch(mine) {
  const dir = store.dataDir();
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (e) {
    log(`no folder ${dir}: ${errText(e)}`);
  }
  if (mine !== generation) return;
  watching = true;
  let empty = 0;
  for (;;) {
    let paths;
    try {
      pending = watchFolder(dir);
      paths = await pending;
    } catch (e) {
      if (mine !== generation) return;
      log(`watch failed, reading every ${TICK_MS} ms: ${errText(e)}`);
      watching = false;
      return;
    }
    if (mine !== generation) return;
    // [] is a released or reclaimed watch: read again, and stop watching when it keeps happening.
    empty = paths.length === 0 ? empty + 1 : 0;
    if (empty >= 3) {
      watching = false;
      return;
    }
    if (paths.length === 0 || paths.some((p) => p.endsWith("/todo.md") || p.replace(/\/+$/, "") === dir)) await reload();
  }
}

/** Starts the service in the `status` copy (nothing during `herdr-app check`; again only after stop()): warm start
 *  from the snapshot, the file read, a folder watch with a timer behind it, and the shown space's repository kept
 *  current. The tasks belong to `cx`'s view. */
export function start(cx) {
  if (started || checking()) return;
  started = true;
  const mine = ++generation;
  store.load(STORE.todo).then(undefined, (e) => log(`snapshot not loaded: ${errText(e)}`));
  reload();
  refreshRepo();
  tasks = [
    cx.spawn(async () => watch(mine)),
    cx.timer.every(TICK_MS, () => {
      ticks += 1;
      if (!watching || ticks % POLL_TICKS === 0) reload();
      refreshRepo();
    }),
  ];
}

/** Stops what start() set going (its timer, folder watch and loop), so a later start(cx) runs anew. The list, its
 *  store value and the undo history stay. */
export function stop() {
  if (!started) return;
  started = false;
  generation += 1;
  watching = false;
  ticks = 0;
  pending?.cancel();
  pending = null;
  for (const task of tasks) {
    try {
      task?.cancel();
    } catch (e) {
      log(`task not cancelled: ${errText(e)}`);
    }
  }
  tasks = [];
}
