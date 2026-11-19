// The agent call tree, spend and past sessions: the mod's side of bin/scan.mjs (ARCHITECTURE §4.3, D1).
//
// The call tree joins three sources per terminal:
//   1. terminals()[].records: the lazuli-tree omp extension's live OSC 7501 child records (one per subagent, id =
//      transcript path, title "type · name[ · failed|aborted]", msg = the task's first line) and `_lazuli`, the
//      root transcript's path. Live: every change re-renders.
//   2. `scan.mjs tree` over that session's transcripts: the whole history (names, types, statuses, times, first
//      lines), and, one node at a time, its full prompt, shared context and result (`detail`).
//   3. terminals()[].parent: hc child terminals, attached to their parent as terminal nodes.
// A terminal whose omp runs without the extension is found through omp's tty breadcrumb; its statuses are
// estimated (`est`).
//
// The "scan" store (snapshot for relay devices) holds `{tree: {at, roots, error}, summary, counts, usage}`: the tree
// scan, subagent counts per root terminal, and the week's spend. Past sessions, node details, runs and calls stay in
// this module (shared by every copy, F3), bounded, fetched by timers and clicks, never by a render. Shared state
// holds only ids and small numbers (selection, folds, view, seen ids, run index, open call).
// The `status` copy runs the watcher (start): scans, failure toasts, counts for the activity badge and the stage.

import { terminals, focused, agents, shared, setShared, exec, run, appHome, home, layout, notify, checking, window as appWindow } from "herdr";
import * as store from "./store.js";
import { STORE } from "./state.js";
import { openPanel } from "./bus.js";
import { t } from "../core/i18n.js";

const key = (k) => `lazuli.tree.${k}`;
/** Shared keys of the call tree's views. */
export const TREE = Object.freeze({
  sel: key("sel"), // {root, id}: root terminal and node id ("" for the root itself)
  open: key("open"), // {"<root>:<id>": true|false}: folds that differ from the default
  view: key("view"), // "list" | "run"
  scope: key("scope"), // "focus" | "space"
  hide: key("hideDone"), // boolean
  seen: key("seen"), // ["<root>:<id>"]: failures someone has looked at
  notified: key("notified"), // ["<root>:<id>"]: failures already toasted
  home: key("homeOpen"), // "<root>:<id>" of the Home card child row shown open
  run: key("run"), // {"<root>": run index} shown by the run view; absent = the latest run
  call: key("call"), // {root, run, card, row, file}: the call opened under its row in the run view
});
/** The reserved record the lazuli-tree extension names the root session with. */
export const SESSION_RECORD = "_lazuli";
/** How often a transcript view reads what was appended (scan.mjs transcript). */
export const TRANSCRIPT_POLL_MS = 2000;

const MAX_IDS = 200;
const MAX_DETAILS = 24;
const MAX_RUNS = 4;
const WATCH_MS = 3000;
const USAGE_MS = 300000;
const SESSIONS_MS = 60000;
const LONG_MS = 120000;

const SCAN = () => `${appHome()}/mods/lazuli/bin/scan.mjs`;
const RUNNING = new Set(["working", "blocked"]);
const FINISHED = new Set(["done", "failed", "aborted", "idle", "unknown"]);
export const isRunning = (status) => RUNNING.has(status);

const str = (v) => (typeof v === "string" && v ? v : null);
const recordsOf = (term) => (term?.records && typeof term.records === "object" ? term.records : {});
const errText = (e) => String(e?.message ?? e).slice(0, 300);
const scanValue = () => store.get(STORE.scan) ?? {};

/** Runs one scan.mjs subcommand and parses its JSON line; throws with its error. */
async function scan(args, timeout) {
  const r = await exec("node", [SCAN(), ...args], timeout ? { timeout } : undefined);
  let out;
  try {
    out = JSON.parse(r.stdout || "{}");
  } catch {
    throw new Error(r.stderr || `scan.mjs exited ${r.code}`);
  }
  if (out?.error || r.code !== 0) throw new Error(out?.error ?? (r.stderr || `scan.mjs exited ${r.code}`));
  return out;
}

/** Merges a part into the "scan" store when it changed (each set rewrites the snapshot and re-renders). */
function put(part) {
  const before = scanValue();
  const next = { ...before, ...part };
  if (JSON.stringify(Object.keys(part).map((k) => before[k])) !== JSON.stringify(Object.keys(part).map((k) => next[k]))) store.set(STORE.scan, next);
}

/** The first line a person would call the task: no blank lines, headings, rules or omp's assignment boilerplate. */
export function oneLiner(text) {
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || /^#{1,6}\s/.test(line) || /^[-*_=]{3,}$/.test(line) || /^```/.test(line)) continue;
    if (/^complete (the )?assignment( thoroughly)?[:.]?$/i.test(line)) continue;
    return line.replace(/^[-*+]\s+|^\d+[.)]\s+/, "").replace(/^\*\*(.+)\*\*$/, "$1");
  }
  return "";
}

const isOmp = (term) => term?.foreground?.name === "omp" || term?.report?.app === "omp" || Boolean(recordsOf(term)[SESSION_RECORD]);
const sessionOf = (term) => str(recordsOf(term)[SESSION_RECORD]?.msg);

/** The machine a terminal address is on (`<machine>/<id>`), or null for this computer. */
const machineOf = (address) => (typeof address === "string" && address.includes("/") ? address.slice(0, address.indexOf("/")) : null);

/** Why a read is refused: scan.mjs runs on this computer only (the mod and its script are not installed on other
 *  machines), and another machine's session paths and pids mean nothing here, or name another agent's history. So a
 *  remote root shows its live records alone; its details, runs, calls and transcripts are `unavailable`. */
export const REMOTE = "remote";

/** The terminals that can root a tree: an omp (with or without the extension), or anything with hc children. */
function candidates(all) {
  const parents = new Set(all.filter((x) => x.parent && x.state === "live").map((x) => x.parent));
  return all.filter((x) => x.state === "live" && (isOmp(x) || parents.has(x.address)));
}

/** This computer's omp roots, as scan.mjs `tree` takes them: by session, else by pid (both local only). */
function scanRoots(all) {
  return candidates(all).filter((x) => isOmp(x) && !machineOf(x.address)).map((x) => {
    const session = sessionOf(x);
    return session ? { key: x.address, session } : { key: x.address, pid: x.foreground?.pid ?? x.pid ?? null };
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The tree scan.

const treeState = { at: 0, sig: "", running: false };

// A copy that closes cancels its pending calls, so a scan it started may never answer. stop() bumps the epoch and
// clears every in-flight flag; an answer from an earlier epoch still lands its data but leaves the flags alone.
let epoch = 0;

/**
 * Asks scan.mjs for the trees (names, types, statuses, times, first lines: no prompts) when what it reads changed,
 * else every 15 s while anything runs and every minute otherwise. The answer goes to the "scan" store, which
 * redraws every copy when it differs. `publish`: the watcher also stores each estimated root's counts.
 */
export function refresh(cx, { force = false, publish = false } = {}) {
  const all = terminals() ?? [];
  const roots = scanRoots(all);
  const sig = JSON.stringify([roots, all.map((x) => [x.address, Object.entries(recordsOf(x)).map(([id, r]) => `${id}=${r?.state}`)])]);
  const known = scanValue().tree?.roots ?? {};
  const live = Object.values(known).some((r) => r.nodes?.some((n) => n.status === "running")) || all.some((x) => Object.values(recordsOf(x)).some((r) => RUNNING.has(r?.state)));
  const limit = force ? 2000 : live ? 15000 : 60000;
  if (treeState.running || (sig === treeState.sig && Date.now() - treeState.at < limit)) {
    if (publish) publishCounts();
    return;
  }
  treeState.running = true;
  treeState.sig = sig;
  treeState.at = Date.now();
  const g = epoch;
  cx.spawn(async () => {
    let next = known;
    let error = null;
    try {
      next = roots.length ? (await scan(["tree", JSON.stringify({ roots })])).roots ?? {} : {};
    } catch (e) {
      error = errText(e);
    }
    if (g === epoch) treeState.running = false;
    const before = scanValue().tree;
    if (JSON.stringify([before?.roots, before?.error ?? null]) !== JSON.stringify([next, error])) put({ tree: { at: Date.now(), roots: next, error } });
    if (publish) publishCounts();
  });
}

/** The last tree scan's error, or null. */
export const scanError = () => scanValue().tree?.error ?? null;

/** Stores the running and failed subagents of every root: estimated roots' scanned counts (`summary`, which
 *  countsOf adds to live records) and each root's full counts (`counts`, for whoever reads the store). */
function publishCounts() {
  const summary = {};
  for (const r of allRoots()) {
    if (!r.est) continue;
    // Nodes with a live record are counted from that record by countsOf; the summary adds only the scan's guesses.
    const nodes = descendants(r).filter((n) => n.kind === "agent" && !n.live);
    const running = nodes.filter((n) => isRunning(n.status)).length;
    const failed = nodes.filter((n) => n.status === "failed" || n.status === "aborted").length;
    if (running || failed) summary[r.address] = { running, failed };
  }
  const all = terminals() ?? [];
  const counts = {};
  for (const term of candidates(all)) {
    const c = countsOf(term.address, all, summary);
    if (c.running || c.failed) counts[term.address] = c;
  }
  put({ summary, counts });
}

// ---------------------------------------------------------------------------------------------------------------------
// Node details: a node's full prompt, shared context and result.

const details = new Map();
const loading = new Set();

/** A node's full prompt, shared context and result, once fetched (null until then; the last fetch while a newer one
 *  runs): {status, at, task, context, result, error}. */
export function detailOf(n) {
  return n?.key ? details.get(n.key) ?? null : null;
}

function remember(n, d, unavailable = null) {
  details.delete(n.key);
  details.set(n.key, { status: n.status, at: Date.now(), task: d.task ?? "", context: d.context ?? "", result: d.result ?? "", error: d.failure ?? null, unavailable });
  while (details.size > MAX_DETAILS) details.delete(details.keys().next().value);
}

/**
 * Fetches a node's detail (from a click or a timer; at most MAX_DETAILS kept): again when its status changes, and
 * every 15 s while it runs (its last message moves). A read that fails settles on the first line.
 */
export function ensureDetail(cx, n) {
  if (!n || n.kind !== "agent" || loading.has(n.key)) return;
  const have = details.get(n.key);
  if (have && have.status === n.status && (!isRunning(n.status) || Date.now() - have.at < 15000)) return;
  if (machineOf(n.root)) {
    remember(n, {}, REMOTE);
    cx.notify();
    return;
  }
  const term = (terminals() ?? []).find((x) => x.address === n.root);
  const session = sessionOf(term) ?? scanValue().tree?.roots?.[n.root]?.session;
  if (!session) {
    remember(n, {});
    cx.notify();
    return;
  }
  loading.add(n.key);
  const g = epoch;
  cx.spawn(async (cx) => {
    let out = {};
    try {
      out = await scan(["detail", session, n.id]);
    } catch {}
    remember(n, out);
    if (g === epoch) loading.delete(n.key);
    cx.notify();
  });
}

function recordStatus(r) {
  const parts = (str(r?.title) ?? "").split(" · ");
  if (r?.state === "error") return parts[2] === "aborted" ? "aborted" : "failed";
  if (r?.state === "working" || r?.state === "blocked" || r?.state === "done" || r?.state === "idle") return r.state;
  return "unknown";
}

// ---------------------------------------------------------------------------------------------------------------------
// The run view's data: runs of roots (scan.mjs `run`, bounded; the last MAX_RUNS asked for kept), and the calls
// opened under their rows (`call`, at most MAX_DETAILS kept). Shared state holds only which run and which call.

const runs = new Map();
const calls = new Map();

export function runIndexOf(root) {
  const v = shared(TREE.run)?.[root];
  return Number.isInteger(v) ? v : null;
}

export function setRunIndex(root, index) {
  const m = { ...(shared(TREE.run) ?? {}) };
  if (index == null) delete m[root];
  else m[root] = index;
  setShared(TREE.run, Object.fromEntries(Object.entries(m).slice(-20)));
  setShared(TREE.call, null);
}

// The root's address (with its machine) is part of every run and call key, so equal paths never share an answer.
const runKey = (root) => (root?.session ? `${root.address}|${root.session}|${runIndexOf(root.address) ?? ""}` : null);

/**
 * Asks scan.mjs for the root's shown run: at once when the run asked for or the root's live state (its status, its
 * children's records) changes, else every 2.5 s while it runs and every 15 s once finished. The root is alive while
 * its terminal still runs omp; past that its undelivered jobs read aborted.
 */
export function refreshRun(cx, root, { force = false } = {}) {
  const k = runKey(root);
  if (!k || machineOf(root.address)) return;
  let st = runs.get(k);
  if (st?.busy) return;
  const term = (terminals() ?? []).find((x) => x.address === root.address);
  const records = {};
  for (const [id, r] of Object.entries(recordsOf(term))) if (!id.startsWith("_") && recordStatus(r) !== "unknown") records[id] = recordStatus(r);
  const sig = JSON.stringify([root.status, records]);
  const live = ["running", "blocked"].includes(st?.data?.run?.status);
  if (st && sig === st.sig && !force && Date.now() - st.at < (live ? 2500 : 15000)) return;
  if (!st) st = { sig: null, data: null, error: null, at: 0, busy: false, done: false };
  runs.delete(k);
  runs.set(k, st);
  while (runs.size > MAX_RUNS) runs.delete(runs.keys().next().value);
  st.sig = sig;
  st.busy = true;
  st.at = Date.now();
  const g = epoch;
  cx.spawn(async (cx) => {
    let data = null;
    let error = null;
    try {
      const alive = term?.state === "live" && isOmp(term);
      data = await scan(["run", JSON.stringify({ session: root.session, run: runIndexOf(root.address), records, alive })]);
    } catch (e) {
      error = errText(e);
    }
    if (g === epoch) st.busy = false;
    const changed = !st.done || error !== st.error || JSON.stringify(data) !== JSON.stringify(st.data);
    Object.assign(st, { data, error, done: true });
    if (changed) cx.notify();
  });
}

/** The shown run of a root: `data` once read, `error`, `loading` until the first answer, `none` without a session,
 *  `unavailable` (with its `error` worded) for a root on another machine. */
export function runOf(root) {
  if (machineOf(root?.address)) return { unavailable: REMOTE, error: t("tree.remote") };
  const k = runKey(root);
  if (!k) return { none: true };
  const st = runs.get(k);
  return st?.done ? { data: st.data, error: st.error } : { loading: true };
}

export function openCall() {
  const v = shared(TREE.call);
  return v && typeof v === "object" ? v : null;
}

export const setOpenCall = (v) => setShared(TREE.call, v);

/** A call's detail as read, keyed by the machine of its root (null: this computer), its file and its row id. */
export const callOf = (file, id, machine = null) => calls.get(`${machine ?? ""}|${file}|${id}`) ?? null;

/** Reads one call's detail when its row opens (again while it is still pending). `machine`: its root's machine. */
export function ensureCall(cx, file, id, machine = null) {
  const k = `${machine ?? ""}|${file}|${id}`;
  const have = calls.get(k);
  if (!file || !id || id.startsWith("live-") || have?.loading || (have && !have.pending)) return;
  if (machine) {
    calls.set(k, { error: t("tree.remote"), unavailable: REMOTE });
    cx.notify();
    return;
  }
  calls.set(k, { ...(have ?? {}), loading: true });
  cx.spawn(async (cx) => {
    let out;
    try {
      out = await scan(["call", JSON.stringify({ file, id })]);
    } catch (e) {
      out = { error: errText(e) };
    }
    calls.delete(k);
    calls.set(k, out);
    while (calls.size > MAX_DETAILS) calls.delete(calls.keys().next().value);
    cx.notify();
  });
}

/** The entries appended to a transcript after `offset` (`{offset, size, items, dropped, reset}`); a view calls it
 *  every TRANSCRIPT_POLL_MS while it shows the transcript. `machine`: its root's machine; another machine's
 *  transcript is refused. Rejects with the scanner's error. */
export async function readTranscript(file, offset = 0, machine = null) {
  if (machine) throw new Error(t("tree.remote"));
  return scan(["transcript", file, String(offset)]);
}

// ---------------------------------------------------------------------------------------------------------------------
// The forest.

const SCANNED = { completed: "done", failed: "failed", aborted: "aborted", running: "working", unknown: "unknown" };

function termStatus(term) {
  const s = typeof term?.status === "string" ? term.status : term?.report?.state ?? null;
  if (s === "error") return "failed";
  return s ?? "terminal";
}

/** A root's name: its omp session title (the terminal title without omp's "π <state>" prefix), else its tab's. */
function rootName(term, agent) {
  const title = str(term.title);
  if (title && /^π\s/.test(title)) {
    const bare = title.replace(/^π\s+\S+\s+/, "").trim();
    if (bare) return bare;
  }
  if (agent?.tab_name && !/^\d+$/.test(agent.tab_name)) return agent.tab_name;
  return title ?? term.address;
}

function shortPath(p) {
  if (!p) return null;
  const h = home();
  return p === h ? "~" : p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
}

/** A terminal's tree: the root (the terminal's own agent), its subagents nested by id, its hc child terminals. */
function buildRoot(term, all, byAddress, scanned, scannedAt) {
  const records = recordsOf(term);
  const session = sessionOf(term);
  const machine = machineOf(term.address);
  const mine = scanned[term.address] ?? null;
  const est = !session;
  const agent = byAddress.get(term.address);
  const rootKey = term.address;
  const nodes = new Map();
  const node = (id) => {
    let n = nodes.get(id);
    if (!n) {
      n = { key: `${rootKey}:${id}`, root: rootKey, machine, id, kind: "agent", name: id.split("/").pop().split(".").pop(), type: null, status: "unknown", task: "", start: null, end: null, durationMs: null, est, live: false, file: null, kids: [], depth: id.split("/").length };
      nodes.set(id, n);
    }
    return n;
  };
  for (const s of mine?.nodes ?? []) {
    Object.assign(node(s.id), {
      type: s.agent ?? null,
      status: SCANNED[s.status] ?? "unknown",
      task: s.line ?? "",
      start: s.start ?? null,
      end: s.end ?? null,
      durationMs: s.durationMs ?? null,
      file: s.file ?? null,
      // Without a live record, a running child is the transcript's guess (revived or never reported).
      est: est || s.status === "running",
    });
  }
  for (const [id, r] of Object.entries(records)) {
    if (id.startsWith("_")) continue;
    const n = node(id);
    const parts = (str(r?.title) ?? "").split(" · ");
    n.live = true;
    n.est = false;
    n.status = recordStatus(r);
    if (parts[0]) n.type = parts[0];
    if (parts[1]) n.name = parts[1];
    if (!n.task) n.task = str(r?.msg) ?? "";
    if (FINISHED.has(n.status) && !n.end && n.start) n.end = scannedAt || Date.now();
    // A remote session's path names a file on that machine: no transcript to open here.
    if (!n.file && session && !machine) n.file = `${session.replace(/\.jsonl$/, "")}/${id}.jsonl`;
  }
  const kids = [];
  for (const n of [...nodes.values()].sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || a.id.localeCompare(b.id))) {
    const parentId = n.id.includes("/") ? n.id.slice(0, n.id.lastIndexOf("/")) : null;
    (parentId && nodes.get(parentId) ? nodes.get(parentId).kids : kids).push(n);
  }
  for (const c of all) {
    if (c.parent !== term.address) continue;
    kids.push({
      key: `${rootKey}:@${c.address}`, root: rootKey, id: `@${c.address}`, kind: "terminal", address: c.address,
      name: str(c.name) ?? str(c.template) ?? (Array.isArray(c.argv) ? c.argv.join(" ") : null) ?? c.address,
      type: t("tree.node.terminal"), status: c.state === "live" ? termStatus(c) : "done", task: [c.address, shortPath(c.cwd)].filter(Boolean).join(" · "),
      start: c.created_ms ?? null, end: c.finished_ms ?? null, durationMs: null, est: false, live: c.state === "live", file: null, kids: [], depth: 1,
    });
  }
  const rootStatus = agent?.status ?? termStatus(term);
  return {
    key: `${rootKey}:`, root: rootKey, id: "", kind: "root", address: term.address, machine, unavailable: machine ? REMOTE : null,
    name: rootName(term, agent),
    type: term.foreground?.name ?? term.report?.app ?? null, status: rootStatus === "error" ? "failed" : rootStatus,
    task: [term.foreground?.name ?? term.report?.app, term.address, shortPath(term.cwd)].filter(Boolean).join(" · "),
    session: session ?? mine?.session ?? null, est, start: mine?.start ?? term.created_ms ?? null, end: null,
    space: term.labels?.["herdr.space"] ?? agent?.space ?? null, kids, depth: 0, live: true, omp: isOmp(term),
    program: agent?.program ?? null,
  };
}

/** Every root this window can show, by terminal address. */
export function allRoots() {
  const all = terminals() ?? [];
  const byAddress = new Map((agents() ?? []).map((a) => [a.address, a]));
  const tree = scanValue().tree;
  return candidates(all).map((x) => buildRoot(x, all, byAddress, tree?.roots ?? {}, tree?.at ?? 0)).filter((r) => r.kids.length || r.omp);
}

/** The roots a scope shows: the focused terminal's alone, or every root in the current space (the focused first). */
export function rootsFor(scope) {
  const f = focused();
  const here = f?.terminal ?? f?.agent ?? null;
  const roots = allRoots();
  if (scope === "space") return roots.filter((r) => r.space === (f?.space ?? null)).sort((a, b) => (b.address === here) - (a.address === here));
  return roots.filter((r) => r.address === here);
}

export function rootOf(address) {
  return allRoots().find((r) => r.address === address) ?? null;
}

/**
 * Running and failed subagents of a terminal, cheap enough for render (fleet's stage, Home's badge): its live
 * records, its live working child terminals, and for a root without the extension the watcher's scanned counts.
 */
export function countsOf(address, all = terminals() ?? [], summary = scanValue().summary) {
  const term = all.find((x) => x.address === address);
  if (!term) return { running: 0, failed: 0 };
  const records = Object.entries(recordsOf(term)).filter(([id]) => !id.startsWith("_")).map(([, r]) => recordStatus(r));
  const kids = all.filter((c) => c.parent === address && c.state === "live" && RUNNING.has(termStatus(c))).length;
  const s = !sessionOf(term) ? summary?.[address] : null;
  return {
    running: records.filter((x) => RUNNING.has(x)).length + kids + (s?.running ?? 0),
    failed: records.filter((x) => x === "failed" || x === "aborted").length + (s?.failed ?? 0),
  };
}

/** Whether a layout block is on screen as far as the layout says: nothing hidden on the way down, and every stack
 *  on the way showing the child that leads to it. */
function blockShown(node, id) {
  if (!node || typeof node !== "object" || node.hidden) return false;
  if (node.id === id) return true;
  const kids = node.children ?? [];
  if (node.active) {
    const shown = kids.find((c) => c.id === node.active);
    return Boolean(shown) && blockShown(shown, id);
  }
  return kids.some((c) => blockShown(c, id)) || (node.floating ?? []).some((c) => blockShown(c, id));
}

/** Whether the tree panel is drawn (the work view, the panel shown on its tree tab). Seeing it also needs the window
 *  in front (appActive). */
export const treeShown = () => blockShown(layout(), "tree");

/** Whether the app's main window has the platform's focus (false behind another app, or on a locked screen). */
export const appActive = () => Boolean(appWindow()?.active);

/** Depth-first, the root first; `open(node)` says whether a node's children show; `hide` leaves finished ones out. */
export function flatten(root, open, hide) {
  const out = [];
  const walk = (n) => {
    if (hide && n.kind !== "root" && n.status === "done" && !n.kids.some(hasRunning)) return;
    out.push(n);
    if (n.kids.length && open(n)) for (const k of n.kids) walk(k);
  };
  walk(root);
  return out;
}

export function descendants(n) {
  return n.kids.flatMap((k) => [k, ...descendants(k)]);
}

export function hasRunning(n) {
  return isRunning(n.status) || n.kids.some(hasRunning);
}

/** The most urgent status among nodes: blocked > failed/aborted > working > done > the rest. */
export function urgent(nodes) {
  const rank = { blocked: 5, failed: 4, aborted: 4, working: 3, done: 2, idle: 1 };
  return nodes.reduce((best, n) => ((rank[n.status] ?? 0) > (rank[best] ?? 0) ? n.status : best), "unknown");
}

/** Whether a node's children show: an explicit fold wins, else depth ≥ 2 starts folded. */
export function isOpen(n) {
  const folds = shared(TREE.open) ?? {};
  if (n.key in folds) return Boolean(folds[n.key]);
  return n.depth < 2;
}

export function setOpen(n, open) {
  const folds = { ...(shared(TREE.open) ?? {}) };
  if (open === n.depth < 2) delete folds[n.key];
  else folds[n.key] = open;
  setShared(TREE.open, Object.fromEntries(Object.entries(folds).slice(-MAX_IDS)));
}

export function selection() {
  const s = shared(TREE.sel);
  return s && typeof s === "object" ? s : null;
}

export const select = (n) => setShared(TREE.sel, n ? { root: n.root, id: n.id } : null);
export const isSelected = (n, sel = selection()) => Boolean(sel && sel.root === n.root && sel.id === n.id);

/** A node by its root and id, in the current forest. */
export function find(rootAddress, id) {
  const root = rootOf(rootAddress);
  if (!root) return null;
  if (!id) return root;
  return [root, ...descendants(root)].find((n) => n.id === id) ?? null;
}

/** Unfolds the root and everything above a node so it shows, and selects it. */
export function reveal(rootAddress, id) {
  const folds = { ...(shared(TREE.open) ?? {}) };
  const parts = id.split("/");
  if (id) folds[`${rootAddress}:`] = true;
  for (let i = 1; i < parts.length; i++) folds[`${rootAddress}:${parts.slice(0, i).join("/")}`] = true;
  setShared(TREE.open, Object.fromEntries(Object.entries(folds).slice(-MAX_IDS)));
  setShared(TREE.sel, { root: rootAddress, id });
}

/** A node's time in ms (running: since its start), or null; views word it. */
export function elapsedMs(n, now) {
  const ms = isRunning(n.status) ? (n.start ? now - n.start : null) : n.durationMs ?? (n.start && n.end ? n.end - n.start : null);
  return ms == null || !Number.isFinite(ms) || ms < 0 ? null : ms;
}

/** Failed or aborted subagents with a live record, which can be toasted and badged (history isn't news). */
export function liveFailures() {
  const out = [];
  for (const term of terminals() ?? []) {
    for (const [id, r] of Object.entries(recordsOf(term))) {
      if (id.startsWith("_") || r?.state !== "error") continue;
      const parts = (str(r?.title) ?? "").split(" · ");
      out.push({ key: `${term.address}:${id}`, root: term.address, id, name: parts[1] ?? id.split("/").pop(), type: parts[0] ?? null, task: str(r?.msg) ?? "", status: recordStatus(r), space: term.labels?.["herdr.space"] ?? null });
    }
  }
  return out;
}

/** Running subagents in the current space (the activity badge), and failures nobody has seen yet. No scan needed. */
export function spaceCounts() {
  const space = focused()?.space ?? null;
  const all = terminals() ?? [];
  const roots = all.filter((x) => x.state === "live" && (!space || x.labels?.["herdr.space"] === space) && isOmp(x));
  const seen = new Set(shared(TREE.seen) ?? []);
  return {
    running: roots.reduce((n, x) => n + countsOf(x.address, all).running, 0),
    unseen: liveFailures().filter((f) => (!space || f.space === space) && !seen.has(f.key)).length,
  };
}

/** Marks the live failures among the drawn nodes (their "<root>:<id>" keys) as seen: the badge goes back to running. */
export function markSeen(drawn) {
  const seen = new Set(shared(TREE.seen) ?? []);
  let changed = false;
  for (const f of liveFailures()) {
    if (drawn.has(f.key) && !seen.has(f.key)) {
      seen.add(f.key);
      changed = true;
    }
  }
  if (changed) setShared(TREE.seen, [...seen].slice(-MAX_IDS));
}

/** The activity button's badge: unseen failures (tone "destructive"), else the space's running subagents
 *  (tone "working"), else null. */
export function badge() {
  const c = spaceCounts();
  if (c.unseen) return { count: c.unseen, tone: "destructive" };
  if (c.running) return { count: c.running, tone: "working" };
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// Spend and past sessions.

const usageState = { running: false, at: 0 };
// The newest past sessions stay in this module, not in the store: the list is large, and the snapshot is rewritten
// on every tree change. Relay devices read their own with scan.mjs.
const sessionsState = { running: false, at: 0, value: null };

/** Reads the week's spend (scan.mjs usage) into the store's `usage` unless it is younger than `maxAgeMs`. Home calls
 *  it when it opens (60 s); the watcher every 5 minutes. */
export function refreshUsage(cx, { maxAgeMs = 60000 } = {}) {
  if (usageState.running || Date.now() - usageState.at < maxAgeMs) return;
  usageState.running = true;
  const g = epoch;
  cx.spawn(async () => {
    let part;
    try {
      part = { ...(await scan(["usage"], LONG_MS)), error: null };
    } catch (e) {
      part = { ...(scanValue().usage ?? {}), error: errText(e) };
    }
    if (g === epoch) usageState.running = false;
    usageState.at = Date.now();
    put({ usage: part });
  });
}

/** The newest past sessions, as last read: `{at, total, sessions, error}`, or null before the first answer. */
export const sessionsOf = () => sessionsState.value;

/** Reads the newest past sessions (scan.mjs sessions, 200) unless younger than `maxAgeMs`, then redraws the asking
 *  copy. The palette calls it when it opens. */
export function refreshSessions(cx, { maxAgeMs = SESSIONS_MS } = {}) {
  if (sessionsState.running || Date.now() - sessionsState.at < maxAgeMs) return;
  sessionsState.running = true;
  const g = epoch;
  cx.spawn(async (cx) => {
    try {
      const out = await scan(["sessions"], LONG_MS);
      sessionsState.value = { at: out.at, total: out.total, sessions: out.sessions ?? [], error: null };
    } catch (e) {
      sessionsState.value = { ...(sessionsState.value ?? { at: null, total: 0, sessions: [] }), error: errText(e) };
    }
    if (g === epoch) sessionsState.running = false;
    sessionsState.at = Date.now();
    cx.notify();
  });
}

/** Past sessions whose title or folder holds `query`, newest first (`limit` at most). Rejects with the scanner's
 *  error. */
export async function findSessions(query, limit = 50) {
  return (await scan(["sessions", JSON.stringify({ query: String(query ?? ""), limit })], LONG_MS)).sessions ?? [];
}

// ---------------------------------------------------------------------------------------------------------------------
// The watcher (status copy) and the tree commands.

function toastFailures() {
  const notified = new Set(shared(TREE.notified) ?? []);
  const fresh = liveFailures().filter((n) => !notified.has(n.key));
  if (!fresh.length) return;
  for (const n of fresh) {
    notified.add(n.key);
    notify({
      title: t(n.status === "aborted" ? "tree.toast.aborted" : "tree.toast.failed", { name: n.name }),
      body: [n.type, n.task].filter(Boolean).join(" · "),
      level: "error",
      timeout: 10000,
      action: { name: `lazuli.tree:open:${n.root}:${n.id}` },
    });
  }
  setShared(TREE.notified, [...notified].slice(-MAX_IDS));
}

const watch = { started: false, timers: [] };

/** Starts the watcher in the status copy (once per layout, always shown): the tree scan and its counts every 3 s,
 *  failure toasts, the week's spend every 5 minutes. Does nothing while it runs or under `herdr-app check`; after
 *  stop() it starts again with the new copy's cx. */
export function start(cx) {
  if (watch.started || checking()) return;
  watch.started = true;
  store.load(STORE.scan);
  refresh(cx, { force: true, publish: true });
  refreshUsage(cx, { maxAgeMs: 0 });
  watch.timers = [
    cx.timer.every(WATCH_MS, (cx) => {
      refresh(cx, { publish: true });
      toastFailures();
    }),
    cx.timer.every(USAGE_MS, (cx) => refreshUsage(cx, { maxAgeMs: USAGE_MS - WATCH_MS })),
  ];
}

/** Stops the watcher (the status copy's close, e.g. a layout switch): cancels its timers and clears every in-flight
 *  flag, since the closing copy's pending scans may never answer. Caches, the store and shared state stay, so the
 *  next start() picks up where this left off. Safe to call when not started. */
export function stop() {
  for (const timer of watch.timers) timer.cancel();
  watch.timers = [];
  watch.started = false;
  epoch += 1;
  // A tree scan still in flight may never answer: the next start scans again at once.
  if (treeState.running) treeState.at = 0;
  treeState.running = false;
  usageState.running = false;
  sessionsState.running = false;
  loading.clear();
  for (const st of runs.values()) st.busy = false;
  for (const [k, v] of [...calls]) {
    if (!v?.loading) continue;
    const { loading: _, ...rest } = v;
    if (Object.keys(rest).length) calls.set(k, rest);
    else calls.delete(k);
  }
}

/** Brings a root into the tree panel's scope (`focus`: the focused terminal's root; `space`: the focused space's
 *  roots): nothing when it is the focused terminal; the space scope when it is in the focused space; else its
 *  terminal is focused, which also shows its space and tab. */
function showRoot(address) {
  const f = focused();
  if ((f?.terminal ?? f?.agent ?? null) === address) return;
  const root = rootOf(address);
  if (!root) return;
  if (root.space && root.space === (f?.space ?? null)) {
    if (shared(TREE.scope) !== "space") setShared(TREE.scope, "space");
    return;
  }
  run("agent.focus", { terminal: address });
}

/** Shows the tree panel on a node: the work view, the panel open on the tree, its root in scope, the node unfolded
 *  and selected. A finished ancestor would hide it while finished rows are hidden, so that filter goes off. */
export function openTreeOn(root, id) {
  if (root) {
    showRoot(root);
    reveal(root, id ?? "");
    const parts = (id ?? "").split("/").slice(0, -1);
    if (shared(TREE.hide) && parts.some((_, i) => find(root, parts.slice(0, i + 1).join("/"))?.status === "done")) setShared(TREE.hide, false);
  }
  openPanel("tree");
}

/**
 * The tree's commands, which the status copy passes here from its `command()`: `tree:open:<root>:<id>` (the panel on
 * a node; toasts use it), `tree:view:<list|run>`, `tree:run:<root>:<index|latest>`, `tree:call:<root>:<run>:<card>:
 * <row>` and `tree:call:close`. True when it was one of these; the windows and transcript openers (`tree:window`,
 * `tree:log:…`) belong to the tree views.
 */
export function command(c, _cx) {
  if (typeof c !== "string") return false;
  if (c.startsWith("tree:open:")) {
    const rest = c.slice("tree:open:".length);
    const at = rest.indexOf(":");
    if (at < 0) openTreeOn(rest, "");
    else openTreeOn(rest.slice(0, at), rest.slice(at + 1));
    return true;
  }
  if (c.startsWith("tree:view:")) {
    setShared(TREE.view, c.endsWith(":run") ? "run" : "list");
    openTreeOn(null, null);
    return true;
  }
  if (c.startsWith("tree:run:")) {
    const [root, index] = c.slice("tree:run:".length).split(":");
    if (root) setRunIndex(root, /^\d+$/.test(index ?? "") ? Number(index) : null);
    return true;
  }
  if (c === "tree:call:close") {
    setOpenCall(null);
    return true;
  }
  if (c.startsWith("tree:call:")) {
    const [root, run, card, ...row] = c.slice("tree:call:".length).split(":");
    if (root && /^\d+$/.test(run ?? "") && row.length) setOpenCall({ root, run: Number(run), card: card ?? "", row: row.join(":"), file: null });
    return true;
  }
  return false;
}
