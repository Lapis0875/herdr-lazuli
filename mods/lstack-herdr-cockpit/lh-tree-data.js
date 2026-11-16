// The agent call tree's model: who started whom, from three sources joined per terminal.
//   1. terminals()[].records: the lstack-herdr-tree omp extension's live OSC 7501 child records (one per subagent,
//      id = transcript path, title "type · name[ · failed|aborted]", msg = the task's first line) and `_session`,
//      the root transcript's path. Live: every change re-renders.
//   2. lh-scan.mjs over that session's transcripts: the whole history (names, types, statuses, times, first lines),
//      and, one node at a time, its full prompt, shared context and result.
//   3. terminals()[].parent: hc child terminals, attached to their parent as terminal nodes.
// A terminal whose omp runs without the extension is found through omp's tty breadcrumb; its statuses are 추정.
//
// Memory: every block of the layout is its own copy of this module, and Herdr hands shared state to every copy of
// every mod on each change. So shared state holds only ids and small numbers (selection, folds, view, seen ids,
// per-root counts); the scan's result and node details live in the copy that asked for them, bounded, fetched by
// timers and clicks, never by a render.

import { terminals, focused, agents, shared, setShared, exec, appHome, layout, window as appWindow } from "herdr";

export const FORK = "lstack-herdr-cockpit";
const key = (k) => `lstack-herdr.tree.${k}`;
export const KEYS = {
  sel: key("sel"), // { root, id }: root terminal and node id ("" for the root itself)
  open: key("open"), // { "<root>:<id>": true|false }: folds that differ from the default
  view: key("view"), // "list" | "run"
  scope: key("scope"), // "focus" | "space"
  hide: key("hideDone"), // boolean
  seen: key("seen"), // ["<root>:<id>"]: failures someone has looked at
  notified: key("notified"), // ["<root>:<id>"]: failures already toasted
  home: key("homeOpen"), // "<root>:<id>" of the Home card child row shown open
  summary: key("summary"), // { "<root>": { running, failed } } for roots without live records (추정), from the watcher
  run: key("run"), // { "<root>": run index } shown by the 실행 view; absent = the latest run
  call: key("call"), // { root, card, row }: the call opened under its row in the 실행 view
  window: key("window"), // the 창으로 크게 보기 window's overlay id while it is open
};
const MAX_IDS = 200;
const MAX_DETAILS = 24;

const SCAN = () => `${appHome()}/mods/${FORK}/lh-scan.mjs`;
const RUNNING = new Set(["working", "blocked"]);
const FINISHED = new Set(["done", "failed", "aborted", "idle", "unknown"]);
export const isRunning = (status) => RUNNING.has(status);

/** This copy's scan: what lh-scan.mjs last said about each root, and the details asked for (oldest dropped first). */
const cache = { at: 0, sig: "", roots: {}, error: null, running: false, details: new Map(), loading: new Set() };

const str = (v) => (typeof v === "string" && v ? v : null);
const recordsOf = (t) => (t?.records && typeof t.records === "object" ? t.records : {});

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

const isOmp = (t) => t?.foreground?.name === "omp" || t?.report?.app === "omp" || Boolean(recordsOf(t)._session);

/** The terminals that can root a tree: an omp (with or without the extension), or anything with hc children. */
function candidates(all) {
  const parents = new Set(all.filter((t) => t.parent && t.state === "live").map((t) => t.parent));
  return all.filter((t) => t.state === "live" && (isOmp(t) || parents.has(t.address)));
}

function scanRoots(all) {
  return candidates(all).filter(isOmp).map((t) => {
    const session = str(recordsOf(t)._session?.msg);
    return session ? { key: t.address, session } : { key: t.address, pid: t.foreground?.pid ?? t.pid ?? null };
  });
}

/**
 * Asks lh-scan.mjs for the trees (names, types, statuses, times, first lines: no prompts), when what it reads
 * changed, else every 15 s while anything runs and every minute otherwise. Redraws this copy when the answer
 * differs. `publish`: the watcher also shares each 추정 root's counts (Home's stage, the badge read them anywhere).
 */
export function refresh(cx, { force = false, publish = false } = {}) {
  const all = terminals() ?? [];
  const roots = scanRoots(all);
  const sig = JSON.stringify([roots, all.map((t) => [t.address, Object.entries(recordsOf(t)).map(([id, r]) => `${id}=${r?.state}`)])]);
  const live = Object.values(cache.roots).some((r) => r.nodes?.some((n) => n.status === "running")) || all.some((t) => Object.values(recordsOf(t)).some((r) => RUNNING.has(r?.state)));
  const limit = force ? 2000 : live ? 15000 : 60000;
  if (cache.running || (sig === cache.sig && Date.now() - cache.at < limit)) return;
  cache.running = true;
  cache.sig = sig;
  cache.at = Date.now();
  cx.spawn(async (cx) => {
    let roots_ = cache.roots, error = null;
    try {
      if (roots.length) {
        const r = await exec("node", [SCAN(), "tree", JSON.stringify({ roots })]);
        const out = JSON.parse(r.stdout || "{}");
        if (out.error || r.code !== 0) throw new Error(out.error ?? (r.stderr || `lh-scan exited ${r.code}`));
        roots_ = out.roots ?? {};
      } else roots_ = {};
    } catch (e) {
      error = String(e?.message ?? e).slice(0, 300);
    }
    cache.running = false;
    const changed = JSON.stringify([cache.roots, cache.error]) !== JSON.stringify([roots_, error]);
    cache.roots = roots_;
    cache.error = error;
    if (publish) publishSummary();
    if (changed) cx.notify();
  });
}

export const scanError = () => cache.error;

function publishSummary() {
  const out = {};
  for (const r of allRoots()) {
    if (!r.est) continue;
    const nodes = descendants(r).filter((n) => n.kind === "agent");
    const running = nodes.filter((n) => isRunning(n.status)).length;
    const failed = nodes.filter((n) => n.status === "failed" || n.status === "aborted").length;
    if (running || failed) out[r.address] = { running, failed };
  }
  if (JSON.stringify(out) !== JSON.stringify(shared(KEYS.summary) ?? {})) setShared(KEYS.summary, out);
}

/** A node's full prompt, shared context and result, once fetched (null until then; the last fetch while a newer one runs). */
export function detailOf(n) {
  return n?.key ? cache.details.get(n.key) ?? null : null;
}

function remember(n, d) {
  cache.details.delete(n.key);
  cache.details.set(n.key, { status: n.status, at: Date.now(), task: d.task ?? "", context: d.context ?? "", result: d.result ?? "", error: d.failure ?? null });
  while (cache.details.size > MAX_DETAILS) cache.details.delete(cache.details.keys().next().value);
}

/**
 * Fetches a node's detail into this copy (from a click or a timer; at most MAX_DETAILS kept): again when its status
 * changes, and every 15 s while it runs (its last message moves). A read that fails settles on the first line.
 */
export function ensureDetail(cx, n) {
  if (!n || n.kind !== "agent" || cache.loading.has(n.key)) return;
  const have = cache.details.get(n.key);
  if (have && have.status === n.status && (!isRunning(n.status) || Date.now() - have.at < 15000)) return;
  const t = (terminals() ?? []).find((x) => x.address === n.root);
  const session = str(recordsOf(t)._session?.msg) ?? cache.roots[n.root]?.session;
  if (!session) {
    remember(n, {});
    cx.notify();
    return;
  }
  cache.loading.add(n.key);
  cx.spawn(async (cx) => {
    let out = {};
    try {
      const r = await exec("node", [SCAN(), "detail", session, n.id]);
      const parsed = JSON.parse(r.stdout || "{}");
      if (!parsed.error) out = parsed;
    } catch {}
    remember(n, out);
    cache.loading.delete(n.key);
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
// The 실행 view's data: one run of one root at a time per copy (lh-scan.mjs `run`, bounded), and the calls opened
// under their rows (`call`, at most MAX_DETAILS kept). Shared state holds only which run and which call.

const runState = { key: null, sig: null, data: null, error: null, at: 0, busy: false };
const calls = new Map();

export function runIndexOf(root) {
  const v = shared(KEYS.run)?.[root];
  return Number.isInteger(v) ? v : null;
}

export function setRunIndex(root, index) {
  const m = { ...(shared(KEYS.run) ?? {}) };
  if (index == null) delete m[root];
  else m[root] = index;
  setShared(KEYS.run, Object.fromEntries(Object.entries(m).slice(-20)));
  setShared(KEYS.call, null);
}

const runKey = (root) => (root?.session ? `${root.address}|${root.session}|${runIndexOf(root.address) ?? ""}` : null);

/**
 * Asks lh-scan.mjs for the root's shown run: at once when the run asked for or the root's live state (its status,
 * its children's records) changes, else every 2.5 s while it runs and every 15 s once finished. The root is alive
 * while its terminal still runs omp; past that its undelivered jobs read 중단.
 */
export function refreshRun(cx, root, { force = false } = {}) {
  const key = runKey(root);
  if (!key || runState.busy) return;
  const t = (terminals() ?? []).find((x) => x.address === root.address);
  const records = {};
  for (const [id, r] of Object.entries(recordsOf(t))) if (!id.startsWith("_") && recordStatus(r) !== "unknown") records[id] = recordStatus(r);
  const sig = JSON.stringify([root.status, records]);
  const live = ["running", "blocked"].includes(runState.data?.run?.status);
  if (key === runState.key && sig === runState.sig && !force && Date.now() - runState.at < (live ? 2500 : 15000)) return;
  runState.sig = sig;
  runState.busy = true;
  runState.at = Date.now();
  cx.spawn(async (cx) => {
    let data = null, error = null;
    try {
      const alive = t?.state === "live" && isOmp(t);
      const r = await exec("node", [SCAN(), "run", JSON.stringify({ session: root.session, run: runIndexOf(root.address), records, alive })]);
      data = JSON.parse(r.stdout || "{}");
      if (data.error || r.code !== 0) throw new Error(data.error ?? (r.stderr || `lh-scan exited ${r.code}`));
    } catch (e) {
      data = null;
      error = String(e?.message ?? e).slice(0, 300);
    }
    runState.busy = false;
    const changed = key !== runState.key || error !== runState.error || JSON.stringify(data) !== JSON.stringify(runState.data);
    Object.assign(runState, { key, data, error });
    if (changed) cx.notify();
  });
}

/** The shown run of a root in this copy: `data` once read, `error`, or `loading` until the first answer. */
export function runOf(root) {
  const key = runKey(root);
  if (!key) return { none: true };
  return runState.key === key ? { data: runState.data, error: runState.error } : { loading: true };
}

export function openCall() {
  const v = shared(KEYS.call);
  return v && typeof v === "object" ? v : null;
}

export const setOpenCall = (v) => setShared(KEYS.call, v);

export const callOf = (file, id) => calls.get(`${file}|${id}`) ?? null;

/** Reads one call's detail into this copy when its row opens (again while it is still pending). */
export function ensureCall(cx, file, id) {
  const k = `${file}|${id}`;
  const have = calls.get(k);
  if (!file || !id || id.startsWith("live-") || have?.loading || (have && !have.pending)) return;
  calls.set(k, { ...(have ?? {}), loading: true });
  cx.spawn(async (cx) => {
    let out;
    try {
      const r = await exec("node", [SCAN(), "call", JSON.stringify({ file, id })]);
      out = JSON.parse(r.stdout || "{}");
    } catch (e) {
      out = { error: String(e?.message ?? e).slice(0, 300) };
    }
    calls.delete(k);
    calls.set(k, out);
    while (calls.size > MAX_DETAILS) calls.delete(calls.keys().next().value);
    cx.notify();
  });
}

const SCANNED = { completed: "done", failed: "failed", aborted: "aborted", running: "working", unknown: "unknown" };

function termStatus(t) {
  const s = typeof t?.status === "string" ? t.status : t?.report?.state ?? null;
  if (s === "error") return "failed";
  return s ?? "terminal";
}

/** A root's name: its omp session title (the terminal title without omp's "π <state>" prefix), else its tab's. */
function rootName(t, agent) {
  const title = str(t.title);
  if (title && /^π\s/.test(title)) {
    const bare = title.replace(/^π\s+\S+\s+/, "").trim();
    if (bare) return bare;
  }
  if (agent?.tab_name && !/^\d+$/.test(agent.tab_name)) return agent.tab_name;
  return title ?? t.address;
}

/** A terminal's tree: the root (the terminal's own agent), its subagents nested by id, its hc child terminals. */
function buildRoot(t, all, byAddress) {
  const records = recordsOf(t);
  const session = str(records._session?.msg);
  const scanned = cache.roots[t.address] ?? null;
  const est = !session;
  const agent = byAddress.get(t.address);
  const rootKey = t.address;
  const nodes = new Map();
  const node = (id) => {
    let n = nodes.get(id);
    if (!n) {
      n = { key: `${rootKey}:${id}`, root: rootKey, id, kind: "agent", name: id.split("/").pop().split(".").pop(), type: null, status: "unknown", task: "", start: null, end: null, durationMs: null, est, live: false, file: null, kids: [], depth: id.split("/").length };
      nodes.set(id, n);
    }
    return n;
  };
  for (const s of scanned?.nodes ?? []) {
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
    if (FINISHED.has(n.status) && !n.end && n.start) n.end = cache.at || Date.now();
    if (!n.file && session) n.file = `${session.replace(/\.jsonl$/, "")}/${id}.jsonl`;
  }
  const kids = [];
  for (const n of [...nodes.values()].sort((a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || a.id.localeCompare(b.id))) {
    const parentId = n.id.includes("/") ? n.id.slice(0, n.id.lastIndexOf("/")) : null;
    (parentId && nodes.get(parentId) ? nodes.get(parentId).kids : kids).push(n);
  }
  for (const c of all) {
    if (c.parent !== t.address) continue;
    kids.push({
      key: `${rootKey}:@${c.address}`, root: rootKey, id: `@${c.address}`, kind: "terminal", address: c.address,
      name: str(c.name) ?? str(c.template) ?? (Array.isArray(c.argv) ? c.argv.join(" ") : null) ?? c.address,
      type: "터미널", status: c.state === "live" ? termStatus(c) : "done", task: [c.address, shortPath(c.cwd)].filter(Boolean).join(" · "),
      start: c.created_ms ?? null, end: c.finished_ms ?? null, durationMs: null, est: false, live: c.state === "live", file: null, kids: [], depth: 1,
    });
  }
  const rootStatus = agent?.status ?? termStatus(t);
  return {
    key: `${rootKey}:`, root: rootKey, id: "", kind: "root", address: t.address,
    name: rootName(t, agent),
    type: t.foreground?.name ?? t.report?.app ?? null, status: rootStatus === "error" ? "failed" : rootStatus,
    task: [t.foreground?.name ?? t.report?.app, t.address, shortPath(t.cwd)].filter(Boolean).join(" · "),
    session: session ?? scanned?.session ?? null, est, start: scanned?.start ?? t.created_ms ?? null, end: null,
    space: t.labels?.["herdr.space"] ?? agent?.space ?? null, kids, depth: 0, live: true, omp: isOmp(t),
    program: agent?.program ?? null,
  };
}

let home = null;
function shortPath(p) {
  if (!p) return null;
  home ??= appHome().replace(/\/\.config\/herdr-app$/, "");
  return p === home ? "~" : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p;
}

/** Every root this window can show, by terminal address. */
export function allRoots() {
  const all = terminals() ?? [];
  const byAddress = new Map((agents() ?? []).map((a) => [a.address, a]));
  return candidates(all).map((t) => buildRoot(t, all, byAddress)).filter((r) => r.kids.length || r.omp);
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
 * Cheap counts for a terminal any copy can ask (fleet.js's stage, Home's badge): its live records, else the
 * watcher's shared counts for a 추정 root. No scan needed.
 */
export function countsOf(address, all = terminals() ?? []) {
  const t = all.find((x) => x.address === address);
  if (!t) return { running: 0, failed: 0 };
  const records = Object.entries(recordsOf(t)).filter(([id]) => !id.startsWith("_")).map(([, r]) => recordStatus(r));
  const kids = all.filter((c) => c.parent === address && c.state === "live" && RUNNING.has(termStatus(c))).length;
  const s = !recordsOf(t)._session ? shared(KEYS.summary)?.[address] : null;
  return {
    running: records.filter((x) => RUNNING.has(x)).length + kids + (s?.running ?? 0),
    failed: records.filter((x) => x === "failed" || x === "aborted").length + (s?.failed ?? 0),
  };
}

function findLayout(node, id) {
  if (!node || typeof node !== "object") return null;
  if (node.id === id) return node;
  for (const c of [...(node.children ?? []), ...(node.floating ?? [])]) {
    const f = findLayout(c, id);
    if (f) return f;
  }
  return null;
}

/** The active child of a layout stack ("center": home|work, "panel-body": the panel tab), or null. */
export function activeChild(stack) {
  return findLayout(layout(), stack)?.active ?? null;
}

/**
 * Whether a layout block is on screen as far as the layout says: no hidden block on the way down to it, and every
 * stack on the way showing the child that leads to it.
 */
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

/**
 * Whether the tree tab is drawn: the center stack on work, the panel shown, panel-body on the tree tab (and nothing
 * above them hidden). Seeing it also needs the window in front (the views ask their window; see TreeBase.looking).
 */
export function treeShown() {
  return blockShown(layout(), "tree");
}

/** Whether the app's main window has the platform's focus (false behind another app, or on a locked screen). */
export function appActive() {
  return Boolean(appWindow()?.active);
}

/** Depth-first, the root first; `open(node)` says whether a node's children show. */
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
  const folds = shared(KEYS.open) ?? {};
  if (n.key in folds) return Boolean(folds[n.key]);
  return n.depth < 2;
}

export function setOpen(n, open) {
  const folds = { ...(shared(KEYS.open) ?? {}) };
  if (open === (n.depth < 2)) delete folds[n.key];
  else folds[n.key] = open;
  const entries = Object.entries(folds);
  setShared(KEYS.open, Object.fromEntries(entries.slice(-MAX_IDS)));
}

export function selection() {
  const s = shared(KEYS.sel);
  return s && typeof s === "object" ? s : null;
}

export const select = (n) => setShared(KEYS.sel, n ? { root: n.root, id: n.id } : null);
export const isSelected = (n, sel = selection()) => Boolean(sel && sel.root === n.root && sel.id === n.id);

/** A node by its root and id, in the current forest. */
export function find(rootAddress, id) {
  const root = rootOf(rootAddress);
  if (!root) return null;
  if (!id) return root;
  return [root, ...descendants(root)].find((n) => n.id === id) ?? null;
}

/** Unfolds everything above a node so it shows (Home's 트리에서 보기, a toast's click). */
export function reveal(rootAddress, id) {
  const folds = { ...(shared(KEYS.open) ?? {}) };
  const parts = id.split("/");
  for (let i = 1; i < parts.length; i++) folds[`${rootAddress}:${parts.slice(0, i).join("/")}`] = true;
  setShared(KEYS.open, Object.fromEntries(Object.entries(folds).slice(-MAX_IDS)));
  setShared(KEYS.sel, { root: rootAddress, id });
}

/** "<1m", "12m", "3h 5m" for a node (running: since its start). */
export function duration(n, now = Date.now()) {
  const ms = isRunning(n.status) ? (n.start ? now - n.start : null) : n.durationMs ?? (n.start && n.end ? n.end - n.start : null);
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "<1m";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
}

/** "2m 14s" exact, for the detail. */
export function exactDuration(n, now = Date.now()) {
  const ms = isRunning(n.status) ? (n.start ? now - n.start : null) : n.durationMs ?? (n.start && n.end ? n.end - n.start : null);
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function span(n) {
  const hm = (ms) => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  };
  if (!n.start) return "";
  return isRunning(n.status) || !n.end ? `${hm(n.start)}–` : `${hm(n.start)}–${hm(n.end)}`;
}

/** Failed or aborted subagents with a live record, which can be toasted and badged (history isn't news). */
export function liveFailures() {
  const out = [];
  for (const t of terminals() ?? []) {
    for (const [id, r] of Object.entries(recordsOf(t))) {
      if (id.startsWith("_") || r?.state !== "error") continue;
      const parts = (str(r?.title) ?? "").split(" · ");
      out.push({ key: `${t.address}:${id}`, root: t.address, id, name: parts[1] ?? id.split("/").pop(), type: parts[0] ?? null, task: str(r?.msg) ?? "", status: recordStatus(r), space: t.labels?.["herdr.space"] ?? null });
    }
  }
  return out;
}

/** Running subagents in the current space (the activity badge), and failures nobody has seen yet. No scan needed. */
export function spaceCounts() {
  const space = focused()?.space ?? null;
  const all = terminals() ?? [];
  const roots = all.filter((t) => t.state === "live" && (!space || t.labels?.["herdr.space"] === space) && isOmp(t));
  const seen = new Set(shared(KEYS.seen) ?? []);
  return {
    running: roots.reduce((n, t) => n + countsOf(t.address, all).running, 0),
    unseen: liveFailures().filter((f) => (!space || f.space === space) && !seen.has(f.key)).length,
  };
}

/** Marks the live failures among the drawn nodes (their "<root>:<id>" keys) as seen: the badge goes back to running. */
export function markSeen(drawn) {
  const seen = new Set(shared(KEYS.seen) ?? []);
  let changed = false;
  for (const f of liveFailures()) if (drawn.has(f.key) && !seen.has(f.key)) {
    seen.add(f.key);
    changed = true;
  }
  if (changed) setShared(KEYS.seen, [...seen].slice(-MAX_IDS));
}
