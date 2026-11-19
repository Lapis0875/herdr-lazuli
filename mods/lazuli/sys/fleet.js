// The agents as lazuli's views see them (ARCHITECTURE §4.2): Herdr's live agents joined with their terminals, the git
// branch where each works, its PR and CI run from the GitHub store, its ticket and its stage (whose move it is); the
// weekly time per ticket (ledger.jsonl); and the keys that walk the agents by stage, open the focused agent's PR or
// ticket. Started by the `status` copy: start(cx) / stop().
// Reference: lstack-herdr-cockpit's `fleet.js`, `status.js` (removed; git history ee5201a).

import * as fs from "fs/promises";
import { agents, terminals, panes, spaces, focused, exec, run, shared, setShared, notify, checking, writeTextFile } from "herdr";
import { stageOf, nextInStage } from "../core/stage.js";
import { ticketOf } from "../core/ticket.js";
import { KEEP_MS, tick as ledgerTick, parseLedger, formatStretches, mergeStretches, dayAndWeekStart, totals } from "../core/ledger.js";
import { t } from "../core/i18n.js";
import * as store from "./store.js";
import { STORE, KEY, NODE } from "./state.js";
import { handle, showCenter, activeChild } from "./bus.js";
import { countsOf } from "./scan.js";
import { runOf } from "./gh.js";

const TICK_MS = 5000;
/** A cwd's branch is asked again after this (ARCHITECTURE §4.2). */
export const BRANCH_MS = 15000;
const REMOTE_MS = 300000;
const GIT_TIMEOUT_MS = 5000;
const GIT_FORGET_MS = 600000;
const TRIM_MS = 86400000;
/** The ledger is kept under the size Herdr's own text reads take (1 MiB), so its compare-and-write can always replace
 *  it. */
const LEDGER_BUDGET = 900000;
/** After a write refused for no reason the file shows, the next try waits this long. */
const REFUSED_MS = 60000;

const log = (msg) => console.log(`[lazuli/fleet] ${msg}`);
const errText = (e) => e?.message ?? String(e);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === "string" && v !== "" ? v : null);
const num = (v) => typeof v === "number" && Number.isFinite(v);

/** The machine a remote address lives on ("vps/t3" → "vps"); null on this computer. */
export const machineOf = (address) => (typeof address === "string" && address.includes("/") ? address.slice(0, address.indexOf("/")) : null);

function live(fn) {
  try {
    return list(fn());
  } catch {
    return [];
  }
}

// Git: each cwd's branch (15 s) and its GitHub remotes (5 min), asked off render and read by rows().

const git = new Map();
const gitKey = (machine, cwd) => `${machine ?? ""}\u0000${cwd}`;
const cleanBranch = (b) => (str(b) && b !== "HEAD" ? b : null);

/** `owner/name` of a GitHub remote URL (https or ssh), else null. */
export function slugOfRemote(url) {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(typeof url === "string" ? url.trim() : "");
  return m ? `${m[1]}/${m[2]}` : null;
}

async function gitOut(args, machine) {
  try {
    const r = await exec("git", args, { on: machine, timeout: GIT_TIMEOUT_MS });
    return r.code === 0 ? r.stdout.trim() : null;
  } catch {
    return null;
  }
}

function cwdOf(term, pane) {
  return str(term?.foreground?.cwd) ?? str(term?.cwd) ?? str(pane?.cwd);
}

async function refreshGit(now) {
  const terms = new Map(live(terminals).map((tm) => [tm.address, tm]));
  const paneOf = new Map(live(panes).map((p) => [p.pane, p]));
  const places = new Map();
  for (const a of live(agents)) {
    const cwd = cwdOf(terms.get(a.address), paneOf.get(a.pane));
    if (cwd) places.set(gitKey(machineOf(a.address), cwd), { cwd, machine: machineOf(a.address) });
  }
  for (const [key, entry] of git) if (!places.has(key) && now - entry.seen > GIT_FORGET_MS) git.delete(key);
  await Promise.all(
    [...places].map(async ([key, { cwd, machine }]) => {
      const entry = git.get(key) ?? { branch: null, branchAt: 0, slug: null, remotes: [], slugAt: 0, seen: now };
      entry.seen = now;
      git.set(key, entry);
      if (entry.busy) return;
      entry.busy = true;
      try {
        if (now - entry.branchAt >= BRANCH_MS) {
          entry.branch = cleanBranch(await gitOut(["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], machine));
          entry.branchAt = now;
        }
        if (now - entry.slugAt >= REMOTE_MS) {
          const remotes = remotesOf(await gitOut(["-C", cwd, "remote", "-v"], machine));
          entry.remotes = remotes.map((r) => r.slug);
          entry.slug = (remotes.find((r) => r.name === "origin") ?? remotes[0])?.slug ?? null;
          entry.slugAt = now;
        }
      } finally {
        entry.busy = false;
      }
    }),
  );
}

// The rows.

/** The GitHub remotes of `git remote -v` output, `{name, slug}` each once, in order. */
export function remotesOf(output) {
  const out = [];
  for (const line of String(output ?? "").split("\n")) {
    const m = /^(\S+)\s+(\S+)/.exec(line.trim());
    const slug = m ? slugOfRemote(m[2]) : null;
    if (slug && !out.some((r) => r.name === m[1] && r.slug === slug)) out.push({ name: m[1], slug });
  }
  return out;
}

/** My open PR on that branch in this checkout, or null. Branch names repeat across repos and forks, so a PR links only
 *  by a full repo identity that is one of the checkout's GitHub remotes (`remotes`, owner/name), and only when exactly
 *  one PR fits: its head repo when GitHub names one (`headRepos`: PR URL → owner/name, STORE.gh), never overridden by
 *  its base repo; its base repo only for a PR GitHub gave no head repo (a deleted fork, an older snapshot). A repo
 *  name alone never links, and a checkout with no GitHub remote known links nothing. */
function prOn(mine, branch, remotes, headRepos) {
  if (!remotes.length) return null;
  const own = remotes.map((s) => s.toLowerCase());
  const head = (p) => (typeof headRepos[p.url] === "string" ? headRepos[p.url].toLowerCase() : null);
  const same = mine.filter((p) => p?.branch === branch);
  const one = (found) => (found.length === 1 ? found[0] : null);
  const byHead = same.filter((p) => head(p) !== null && own.includes(head(p)));
  if (byHead.length) return one(byHead);
  return one(same.filter((p) => head(p) === null && own.includes(String(p.slug).toLowerCase())));
}

/** Every agent now, in Herdr's order: `{address, pane, space, space_name, tab, tab_name, status, app, program, title,
 *  seq, pinned, focused, cwd, branch, slug, pr, run, ticket, subagents, snoozedUntil, stage, since}`. `pr` is a Pr of
 *  STORE.gh `mine`, `run` its CI Run, `ticket` `{key, url}`, `since` when its tab last changed state. Live and cheap:
 *  safe in render. */
export function rows(now = Date.now()) {
  const terms = live(terminals);
  const termOf = new Map(terms.map((tm) => [tm.address, tm]));
  const paneOf = new Map(live(panes).map((p) => [p.pane, p]));
  const tabOf = new Map();
  for (const s of live(spaces)) for (const tab of list(s.tabs)) tabOf.set(tab.id, tab);
  const gh = store.get(STORE.gh);
  const mine = list(gh?.mine);
  const headRepos = isObj(gh?.headRepos) ? gh.headRepos : {};
  const snoozed = shared(KEY.snooze);
  // Running subagents per agent from the call tree (sys/scan.js: OSC child records, live child terminals, scans).
  const subagents = (address) => {
    try {
      const n = countsOf(address, terms)?.running;
      return num(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  };
  return live(agents).map((a) => {
    const term = termOf.get(a.address);
    const pane = paneOf.get(a.pane);
    const cwd = cwdOf(term, pane);
    const g = cwd ? git.get(gitKey(machineOf(a.address), cwd)) : null;
    const branch = g?.branch ?? cleanBranch(pane?.branch);
    const slug = g?.slug ?? null;
    const pr = branch ? prOn(mine, branch, g?.remotes ?? [], headRepos) : null;
    const ci = pr ? runOf(pr) : null;
    const until = isObj(snoozed) ? snoozed[a.address] : null;
    const row = {
      address: a.address,
      pane: a.pane,
      space: a.space,
      space_name: a.space_name,
      tab: a.tab,
      tab_name: a.tab_name,
      status: a.status,
      app: a.app ?? null,
      program: a.program ?? null,
      title: a.title,
      seq: a.seq,
      pinned: Boolean(a.pinned),
      focused: Boolean(a.focused),
      cwd,
      branch,
      slug,
      pr,
      run: ci,
      ticket: ticketOf({ body: pr?.body, branch }),
      subagents: subagents(a.address),
      snoozedUntil: num(until) && until > now ? until : null,
      since: tabOf.get(a.tab)?.changed_at ?? null,
    };
    row.stage = stageOf(row, now);
    return row;
  });
}

/** The agent the person looks at: the agent block's, else the focused pane's; null when it is not an agent. */
export function current(list_ = rows()) {
  const f = focused();
  const address = f?.agent ?? f?.terminal ?? null;
  return list_.find((a) => a.address === address) ?? null;
}

// The keys that walk the agents (⌘J, ⇧⌘J, ⇧⌘U): the stages each visits, in order. ⌘J goes to an agent that needs you,
// else to a finished one waiting for its next prompt, and a toast says it fell back; ⇧⌘J and ⇧⌘U visit one stage only.
// With none to visit, focus stays where it is and a toast says so.

export const NEXT = Object.freeze({
  "next-waiting": Object.freeze(["needs", "done"]),
  "next:blocked": Object.freeze(["needs"]),
  "next:done": Object.freeze(["done"]),
});

/** The agents a walk visits for a stage, waiting longest first (lowest `seq`): those of that stage, and for "done"
 *  also those Herdr reports done (finished unseen) whatever their PR says. Shaped for nextInStage. */
export function candidates(stage, list_ = rows()) {
  return list_
    .filter((a) => a.stage === stage || a.status === stage)
    .map((a, i) => ({ a, i }))
    .sort((x, y) => (num(x.a.seq) ? x.a.seq : 0) - (num(y.a.seq) ? y.a.seq : 0) || x.i - y.i)
    .map(({ a }) => ({ address: a.address, stage }));
}

/** The next agent for a walk command after `current` (an address): `{address, stage}`, the stage the walk found it in,
 *  or null. */
export function nextAgent(command, current_ = currentAddress(), list_ = rows()) {
  for (const stage of NEXT[command] ?? []) {
    const address = nextInStage(candidates(stage, list_), stage, current_);
    if (address) return { address, stage };
  }
  return null;
}

function currentAddress() {
  const f = focused();
  return f?.terminal ?? f?.agent ?? null;
}

/** Brings an agent's terminal in front: focused, in the work view. */
export function goTo(address) {
  run("agent.focus", { terminal: address });
  if (activeChild(NODE.center) !== "work") showCenter("work");
}

/** Snoozes an agent until `until` (ms), or wakes it (null); expired entries are dropped. */
export function setSnooze(address, until, now = Date.now()) {
  const was = shared(KEY.snooze);
  const next = {};
  for (const [k, v] of Object.entries(isObj(was) ? was : {})) if (num(v) && v > now && k !== address) next[k] = v;
  if (num(until) && until > now) next[address] = until;
  setShared(KEY.snooze, next);
}

function walk(_cx, { command }) {
  const next = nextAgent(command);
  if (!next) {
    notify({ title: t(command === "next:done" ? "home.next.noneDone" : "home.next.noneWaiting"), level: "info", timeout: 3000 });
    return;
  }
  goTo(next.address);
  if (next.stage !== NEXT[command][0]) notify({ title: t("home.next.movedToDone"), level: "info", timeout: 3000 });
}

function openPr() {
  const url = current()?.pr?.url;
  if (url) return exec("open", [url]);
}

function openTicket() {
  const ticket = current()?.ticket;
  if (!ticket) return;
  if (ticket.url) return exec("open", [ticket.url]);
  notify({ title: t("inbox.ticket-no-link", { key: ticket.key }), level: "info", timeout: 4000 });
}

// The ledger: who works on what, checkpointed every minute into data/lazuli/ledger.jsonl, kept 35 days. The file is
// only ever replaced by text built on what was read from it: `disk` is its text as last read or written (null: no
// file), new stretches wait in `pending` until a write lands. A file that cannot be read is never written: the
// ledger stays unloaded and loading is tried again on the next tick, stretches piling up in `pending` meanwhile.

const led = { open: {}, stretches: [], pending: [], disk: null, loaded: false, loading: null, chain: Promise.resolve(), refusedAt: 0, trimmedAt: 0, warned: {} };
const ledgerPath = () => `${store.dataDir()}/ledger.jsonl`;

function warnOnce(kind, msg) {
  if (led.warned[kind]) return;
  led.warned[kind] = true;
  log(msg);
  store.debugLog("fleet", msg);
}

/** The ledger file now: `{ok: true, text}` (null: no file) or `{ok: false}` when it could not be read. */
async function readLedgerFile() {
  try {
    if (!(await fs.exists(ledgerPath()))) return { ok: true, text: null };
    return { ok: true, text: await fs.readFile(ledgerPath(), "utf8") };
  } catch (e) {
    warnOnce("read", `ledger not read, history kept on disk and writes held: ${errText(e)}`);
    return { ok: false };
  }
}

function loadLedger(now) {
  if (!led.loading) {
    led.loading = (async () => {
      const got = await readLedgerFile();
      if (!got.ok) return;
      led.warned.read = false;
      const kept = parseLedger(got.text ?? "", now - KEEP_MS);
      led.disk = got.text;
      led.stretches = [...kept, ...led.pending];
      led.trimmedAt = now;
      led.loaded = true;
      // Lines past 35 days (or not a stretch) go now, an oversized file is compacted, and stretches made while the
      // file was unreadable are written.
      const text = got.text ?? "";
      const trim = text.length > LEDGER_BUDGET || formatStretches(kept) !== text;
      if (trim || led.pending.length) await writeLedger(now, trim);
    })().finally(() => {
      led.loading = null;
    });
  }
  return led.loading;
}

/** The file's next text: `add` after `base`, unless that outgrows LEDGER_BUDGET or `trim` asks for the whole file
 *  again: then compacted, with each long stretch's minute checkpoints merged into one line and lines past 35 days
 *  left out; still too large, only the last two weeks are kept, then this week (what the views show). `all` is the
 *  stretches a compacted text holds, else null. */
function nextText(base, add, now, trim) {
  const appended = base + formatStretches(add);
  if (!trim && appended.length <= LEDGER_BUDGET) return { text: appended, all: null };
  let all = mergeStretches([...parseLedger(base, now - KEEP_MS), ...add.filter((s) => s.end > now - KEEP_MS)]);
  let text = formatStretches(all);
  const week = dayAndWeekStart(now).week;
  for (const since of [week - 7 * 86400000, week]) {
    if (text.length <= LEDGER_BUDGET) break;
    all = all.filter((s) => s.end > since);
    text = formatStretches(all);
  }
  return { text, all };
}

/** Writes the pending stretches after what the file holds (`trim`: the whole file again, compacted). Writes run one
 *  after another (a call made while one is under way waits for it, then writes what is pending then), and resolve
 *  when done. Compare-and-write only: the native write lands while the file still holds `disk`; when it changed
 *  underneath, the text is rebuilt on what it holds now. Nothing is written when the file cannot be read, and a
 *  refusal it does not explain keeps the stretches pending, tried again after REFUSED_MS (`final`, the last write at
 *  stop, does not wait for that). */
function writeLedger(now, trim = false, final = false) {
  const run = led.chain.then(() => writeOnce(now, trim, final));
  led.chain = run.catch(() => {});
  return run;
}

async function writeOnce(now, trim, final) {
  if (!led.loaded || (!final && now - led.refusedAt < REFUSED_MS)) return;
  try {
    await fs.mkdir(store.dataDir(), { recursive: true });
    for (let tries = 0; tries < 3; tries++) {
      const sent = led.pending.length;
      const { text: next, all } = nextText(led.disk ?? "", led.pending.slice(0, sent), now, trim);
      const commit = () => {
        led.disk = next;
        led.pending = led.pending.slice(sent);
        if (all) {
          led.stretches = [...all, ...led.pending];
          led.trimmedAt = now;
        }
        led.refusedAt = 0;
        led.warned.write = false;
      };
      if (next === led.disk) {
        commit();
        return;
      }
      try {
        await writeTextFile(ledgerPath(), next, led.disk);
        commit();
        return;
      } catch (e) {
        const got = await readLedgerFile();
        if (!got.ok) return;
        if (got.text === led.disk) {
          led.refusedAt = now;
          warnOnce("write", `ledger write refused, stretches kept pending: ${errText(e)}`);
          return;
        }
        led.disk = got.text;
        led.stretches = [...parseLedger(got.text ?? "", now - KEEP_MS), ...led.pending];
      }
    }
  } catch (e) {
    warnOnce("write", `ledger not written: ${errText(e)}`);
  }
}

async function ledgerStep(list_, now) {
  if (!led.loaded) await loadLedger(now);
  const working = list_.filter((a) => a.status === "working").map((a) => ({ terminal: a.address, ticket: a.ticket?.key ?? "" }));
  const r = ledgerTick(led.open, working, now);
  led.open = r.open;
  const done = r.done.filter((s) => s.end > s.start);
  led.pending.push(...done);
  led.stretches.push(...done);
  const trim = now - led.trimmedAt >= TRIM_MS;
  if (led.loaded && (led.pending.length || trim)) await writeLedger(now, trim);
}

/** Working time: ledger.totals over the written stretches and the ones going on now (Recap's weekly time). */
export function time(now = Date.now()) {
  const open = Object.entries(led.open).map(([terminal, o]) => ({ start: o.start, end: now, ticket: o.ticket, terminal }));
  return totals([...led.stretches, ...open], now);
}

// The service.

const fl = { running: false, timer: null, busy: false, unhandle: [], published: "" };

function publish(list_, now) {
  const digest = JSON.stringify(list_);
  if (digest === fl.published) return;
  fl.published = digest;
  store.set(STORE.fleet, { version: 1, at: now, agents: list_ });
}

async function tickOnce() {
  if (fl.busy) return;
  fl.busy = true;
  try {
    const now = Date.now();
    await refreshGit(now);
    const list_ = rows(now);
    publish(list_, now);
    await ledgerStep(list_, now);
  } catch (e) {
    log(`tick failed: ${errText(e)}`);
  } finally {
    fl.busy = false;
  }
}

/** Starts the fleet (the `status` copy's init): git lookups, the STORE.fleet snapshot, the ledger, and the handlers
 *  of next-waiting, next:blocked, next:done, pr and ticket. Safe to call again; does nothing under `herdr-app check`. */
export function start(cx) {
  if (fl.running || checking()) return;
  fl.running = true;
  fl.unhandle = [
    handle("next-waiting", walk),
    handle("next:blocked", walk),
    handle("next:done", walk),
    handle("pr", openPr),
    handle("ticket", openTicket),
  ];
  cx.spawn(async () => {
    await loadLedger(Date.now());
    await tickOnce();
  });
  fl.timer = cx.timer.every(TICK_MS, (cx) => {
    if (fl.running) cx.spawn(async () => tickOnce());
  });
}

/** Stops the fleet (the `status` copy's close): the open stretches are closed and written as they stand, after any
 *  write under way (when the ledger could be read). Returns that write, for a close that can wait for it. */
export function stop() {
  if (!fl.running) return Promise.resolve();
  fl.running = false;
  fl.timer?.cancel();
  fl.timer = null;
  for (const off of fl.unhandle) off();
  fl.unhandle = [];
  const now = Date.now();
  const r = ledgerTick(led.open, [], now);
  led.open = r.open;
  const done = r.done.filter((s) => s.end > s.start);
  led.pending.push(...done);
  led.stretches.push(...done);
  return led.loaded && led.pending.length ? writeLedger(now, false, true) : Promise.resolve();
}
