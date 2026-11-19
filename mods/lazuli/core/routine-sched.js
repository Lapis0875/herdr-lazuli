// The routine scheduler as a reducer over `data/lazuli/routines-state.json` (ARCHITECTURE §4.6, DESIGN A6):
// one round applies the runs that ended, queues what is due on its schedule or set off by gh events, starts
// what the parallel limit allows and stops what ran too long. The caller (`sys/routines.js`) launches and
// stops the runs the round names. A port of cockpit 0.38.5 `hub/src/routines.rs` (round, schedule, listen,
// start_queued, finish), with codes instead of sentences. Pure: `now` is always an argument.
//
// Every function here is an operation `state → state`: two scheduler instances on one state file each
// apply theirs to the file's current state (compare-and-write, re-applied after a conflict), never merge.
// A scheduled run's occurrence is its `why.at` (the due time), kept in its queued job, running entry and
// record, so an occurrence already queued, running or done is never claimed again, whoever claimed it.

import { lastDue, nextAfter, setsOff } from "./routine-file.js";
import { summaryLine } from "./agent-cmd.js";

export const TICK_MS = 15000;
/** A due time that falls between two rounds of a scheduler that kept running (rounds at most this far
 *  apart) runs on time, whatever the routine's catch-up window. */
export const ON_TIME_MS = 120000;
export const KEEP_RUNS = 20;
/** One routine runs once per change (event kind and PR) in this long: longer than gh's longest poll backoff
 *  (15 min) plus a tick, so the same change seen late by another instance does not run it again. */
export const EVENT_GAP_MS = 1200000;
/** A run asked to stop that still runs this long after is killed. */
export const KILL_AFTER_MS = 10000;
export const WEEK_MS = 604800000;
/** How long a scheduler instance's lease lasts unless renewed (every round renews it). */
export const LEASE_MS = 3 * TICK_MS;

const DEFAULT_PARALLEL = 3;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const str = (v) => (typeof v === "string" ? v : "");
const clone = (v) => JSON.parse(JSON.stringify(v));
// Slug- and key-indexed tables have no prototype, so a routine named `constructor`, `toString` or
// `__proto__` is an ordinary key; values read from outside go through `own`.
const dict = () => Object.create(null);
const own = (o, k) => (isObj(o) && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);

/** A state with nothing seen, run or queued. */
export function emptyState() {
  return { version: 1, marks: {}, running: {}, queued: [], runs: {}, costs: {} };
}

const isCost = (c) => isObj(c) && typeof c.at === "number" && Number.isFinite(c.at) && typeof c.usd === "number" && Number.isFinite(c.usd);

// The costs of each routine's runs, `{[slug]: [{at, usd}]}` with `at` = the run's start, kept for a week apart
// from the 20 records shown, so a budget counts every run of the week. A state from before it had them is
// read from its records.
function costsOf(s, runs) {
  const costs = dict();
  if (isObj(s.costs)) {
    for (const [slug, list] of Object.entries(s.costs)) if (Array.isArray(list)) costs[slug] = list.filter(isCost).map((c) => ({ at: c.at, usd: c.usd }));
    return costs;
  }
  for (const [slug, list] of Object.entries(runs)) {
    const paid = list.filter((r) => typeof r.started === "number" && typeof r.cost === "number" && Number.isFinite(r.cost)).map((r) => ({ at: r.started, usd: r.cost }));
    if (paid.length) costs[slug] = paid;
  }
  return costs;
}

function marksOf(raw) {
  const marks = dict();
  if (!isObj(raw)) return marks;
  for (const [slug, m] of Object.entries(raw)) {
    if (!isObj(m)) continue;
    const mark = { ...m };
    if (isObj(m.events)) {
      mark.events = dict();
      for (const [key, at] of Object.entries(m.events)) mark.events[key] = at;
    } else {
      delete mark.events;
    }
    marks[slug] = mark;
  }
  return marks;
}

const isEvent = (e) => isObj(e) && typeof e.kind === "string" && typeof e.key === "string";
/** Events other instances offered (`offerEvents`) that the leader has not consumed yet, newest last. */
export const MAX_PENDING_EVENTS = 100;

// A fresh, complete copy of any state value, its tables without prototypes.
function normalize(state) {
  const s = isObj(state) ? clone(state) : {};
  const runs = dict();
  if (isObj(s.runs)) for (const [slug, list] of Object.entries(s.runs)) if (Array.isArray(list)) runs[slug] = list.filter(isObj);
  const running = dict();
  if (isObj(s.running)) for (const [slug, run] of Object.entries(s.running)) if (isObj(run)) running[slug] = run;
  const out = {
    ...s,
    version: 1,
    marks: marksOf(s.marks),
    running,
    queued: Array.isArray(s.queued) ? s.queued.filter((q) => isObj(q) && typeof q.slug === "string") : [],
    runs,
    costs: costsOf(s, runs),
  };
  const pending = Array.isArray(s.pendingEvents) ? s.pendingEvents.filter(isEvent) : [];
  if (pending.length) out.pendingEvents = pending;
  else delete out.pendingEvents;
  return out;
}

/** Any state value (a parsed state file) as a complete state whose slug-indexed tables have no prototype:
 *  what callers keep, so `state.runs[slug]` is safe for any slug. */
export function normalizeState(state) {
  return normalize(state);
}

// Costs that left the week go.
function pruneCosts(s, now) {
  for (const [slug, list] of Object.entries(s.costs)) {
    const kept = list.filter((c) => now - c.at < WEEK_MS);
    if (kept.length) s.costs[slug] = kept;
    else delete s.costs[slug];
  }
}

const busy = (s, slug) => isObj(s.running[slug]) || s.queued.some((q) => q.slug === slug);
const usable = (r) => isObj(r) && typeof r.slug === "string" && isObj(r.when) && typeof r.when.error !== "string";
// A routine whose file could not be read this time: it neither schedules nor starts, and its queued jobs wait.
const held = (r) => isObj(r) && r.unavailable === true;
const SCHEDULED = new Set(["schedule", "interval"]);

// Whether the occurrence due at `at` was queued, runs or has a record already.
function occurred(s, slug, at) {
  const same = (why) => isObj(why) && SCHEDULED.has(why.kind) && why.at === at;
  return (
    same(own(s.running, slug)?.why) ||
    s.queued.some((q) => q.slug === slug && same(q.why)) ||
    (own(s.runs, slug) ?? []).some((r) => same(r.why))
  );
}

// The record on top of the routine's past runs; the ones past KEEP_RUNS go to `drop`.
function record(s, slug, rec, drop) {
  const runs = [rec, ...(s.runs[slug] ?? [])];
  for (const old of runs.slice(KEEP_RUNS)) drop.push({ slug, id: old.id });
  s.runs[slug] = runs.slice(0, KEEP_RUNS);
}

// A notification as the routine's `notify` asks.
function tell(r, rec, notify) {
  if (!isObj(r) || r.notify === "never" || (r.notify === "failed" && rec.ok)) return;
  const kind = rec.missed ? "missed" : rec.ok ? "ok" : "failed";
  notify.push({ slug: r.slug, kind, name: str(r.name), summary: str(rec.summary) });
}

function finish(s, f, r, now, out) {
  const slug = f.slug;
  const run = s.running[slug];
  // Only the run it names: another may have taken the routine's slot since (another instance's).
  if (!isObj(run) || (f.id !== undefined && f.id !== run.id)) return;
  // The run of a deleted routine (`forget`) leaves no record; its files go.
  if (run.forgotten === true) {
    delete s.running[slug];
    out.drop.push({ slug, id: run.id });
    return;
  }
  const code = typeof f.code === "number" ? f.code : null;
  const stopping = run.stopping !== undefined && run.stopping !== null;
  const rec = {
    id: run.id,
    started: run.started,
    ended: now,
    ok: code === 0 && f.isError !== true && !stopping,
    code,
    why: run.why,
    summary: summaryLine(str(f.text)),
  };
  if (typeof f.usd === "number" && Number.isFinite(f.usd)) {
    rec.cost = f.usd;
    if (typeof run.started === "number" && Number.isFinite(run.started)) s.costs[slug] = [...(s.costs[slug] ?? []), { at: run.started, usd: f.usd }];
  }
  if (typeof f.session === "string" && f.session) rec.session = f.session;
  if (run.late === true) rec.late = true;
  if (run.timedOut === true) rec.timedOut = true;
  else if (stopping) rec.stopped = true;
  const worktree = isObj(f.worktree) ? f.worktree : run.worktree;
  if (isObj(worktree)) rec.worktree = worktree;
  if (typeof f.error === "string" && f.error) rec.error = f.error;
  delete s.running[slug];
  record(s, slug, rec, out.drop);
  tell(r, rec, out.notify);
}

// A due time came. While the scheduler kept running (`prev`, the previous round, before it and at most
// ON_TIME_MS before now) it runs on time. Otherwise it was due while nothing ran (a restart, the service
// stopped, a pause): it runs if late by at most the catch-up window exactly (`never` = 0), marked `late`
// past 2 min, else one `missed` record. `kind` is the Why kind ("schedule" or "interval").
function due(s, r, at, now, prev, kind, out) {
  const late = now - at;
  const onTime = prev !== null && prev < at && now - prev <= ON_TIME_MS;
  if (onTime || late <= num(r.catchUp) * 60000) {
    if (!onTime && late > ON_TIME_MS) s.queued.push({ slug: r.slug, why: { kind, at, late: true }, event: null, late: true });
    else s.queued.push({ slug: r.slug, why: { kind, at }, event: null });
    return true;
  }
  const rec = { id: String(at), started: at, ended: at, ok: false, missed: true, code: null, why: { kind, at }, summary: "" };
  record(s, r.slug, rec, out.drop);
  tell(r, rec, out.notify);
  return false;
}

// Queues what came due: an interval once it passed since the last run, a schedule at its time; after a
// gap, the latest due time runs within the routine's catch-up window, else is recorded `missed` (DESIGN A6).
// An occurrence already queued, running or recorded is not taken again.
function schedule(s, list, now, prev, out) {
  for (const r of list) {
    if (r.paused === true || held(r) || !usable(r)) continue;
    const m = s.marks[r.slug];
    const base = Math.max(num(m.seen), num(m.fired));
    if (r.when.kind === "every") {
      const step = num(r.when.secs) * 1000;
      if (step <= 0 || now < base + step) continue;
      // The latest time it came due: the interval counted from the last run, as many times as fit.
      const at = base + Math.floor((now - base) / step) * step;
      if (busy(s, r.slug) || occurred(s, r.slug, at)) {
        m.fired = now;
        continue;
      }
      // A run counts the next interval from now; a missed one from its due time.
      m.fired = due(s, r, at, now, prev, "interval", out) ? now : at;
    } else if (r.when.kind === "cron") {
      const at = lastDue(r.when, base, now);
      if (at === null) continue;
      m.fired = Math.max(at, base);
      if (!busy(s, r.slug) && !occurred(s, r.slug, at)) due(s, r, at, now, prev, "schedule", out);
    }
  }
}

// Queues the routines the events set off, once per change (kind and key) in EVENT_GAP_MS; old ones are
// forgotten.
function listen(s, list, events, now) {
  for (const e of events) {
    if (!isObj(e)) continue;
    const key = str(e.key);
    const change = `${str(e.kind)} ${key}`;
    for (const r of list) {
      if (r.paused === true || held(r) || !usable(r) || !setsOff(r.when, e)) continue;
      const m = s.marks[r.slug];
      if (!isObj(m.events)) m.events = dict();
      const last = m.events[change];
      if ((typeof last === "number" && now - last < EVENT_GAP_MS) || busy(s, r.slug)) continue;
      m.events[change] = now;
      const event = { kind: str(e.kind), key, title: str(e.title), url: str(e.url) };
      s.queued.push({ slug: r.slug, why: { kind: "event", title: event.title }, event });
    }
  }
  for (const m of Object.values(s.marks)) {
    if (!isObj(m.events)) continue;
    for (const [change, at] of Object.entries(m.events)) if (now - num(at) >= EVENT_GAP_MS) delete m.events[change];
  }
}

// Starts queued runs, oldest first, while fewer than `max` run; drops one whose routine is gone or broken,
// one whose routine was paused while it waited (unless run by hand), and one over its weekly budget
// (saying so once per stretch).
function startQueued(s, bySlug, now, max, owner, out) {
  const left = [];
  for (const q of s.queued) {
    const r = bySlug.get(q.slug);
    if (held(r)) {
      left.push(q);
      continue;
    }
    if (!usable(r)) continue;
    // A scheduled or event job of a routine paused meanwhile goes without a record, as a paused routine
    // queues none; a run asked for by hand still starts.
    if (r.paused === true && (isObj(q.why) ? q.why.kind : "manual") !== "manual") continue;
    if (Object.keys(s.running).length >= max || isObj(s.running[q.slug])) {
      left.push(q);
      continue;
    }
    const m = s.marks[q.slug] ?? (s.marks[q.slug] = { seen: now, fired: 0 });
    if (typeof r.budget === "number" && spentWeek(s, q.slug, now) >= r.budget - 0.01) {
      if (m.over !== true) {
        m.over = true;
        out.notify.push({ slug: q.slug, kind: "over-budget", name: str(r.name), summary: "" });
      }
      continue;
    }
    m.over = false;
    // Unique per scheduler instance, still sorting by time: two instances claiming in the same millisecond
    // never share a run id (and so run files).
    const id = owner ? `${now}-${owner.slice(0, 6)}` : String(now);
    const why = isObj(q.why) ? q.why : { kind: "manual" };
    const event = isObj(q.event) ? q.event : null;
    const run = { id, started: now, why, event, timeout: num(r.timeout) || 30 };
    if (owner) run.owner = owner;
    if (q.late === true) run.late = true;
    if (q.retry === true) run.retry = true;
    s.running[q.slug] = run;
    out.start.push({ slug: q.slug, id, why, event });
  }
  s.queued = left;
}

// Stops runs asked to stop (`requestStop`, `forget`) that were not signalled yet, and runs past their
// timeout; kills the ones a stop did not end within KILL_AFTER_MS.
function timeOut(s, now, out) {
  for (const [slug, run] of Object.entries(s.running)) {
    const stopping = typeof run.stopping === "number" ? run.stopping : null;
    if (stopping === null && now > num(run.started) + (num(run.timeout) || 30) * 60000) {
      run.timedOut = true;
      run.stopping = now;
      run.signalled = true;
      out.stop.push({ slug, id: run.id, kill: false });
    } else if (stopping !== null && run.signalled !== true) {
      run.signalled = true;
      out.stop.push({ slug, id: run.id, kill: false });
    } else if (stopping !== null && now > stopping + KILL_AFTER_MS) {
      out.stop.push({ slug, id: run.id, kill: true });
    }
  }
}

/** The scheduler lease: one instance at a time runs rounds, launches and cleans up. `owner` gets it (until
 *  now + LEASE_MS) when it holds it already or nobody holds an unexpired one; `ok` false: another
 *  instance leads, and the state is unchanged. */
export function lead(state, owner, now) {
  const s = normalize(state);
  const l = s.leader;
  if (isObj(l) && l.owner !== owner && typeof l.until === "number" && l.until > now) return { state: s, ok: false };
  // Taking over: who led before, and until when, so its launches still under way are not judged lost.
  if (isObj(l) && l.owner !== owner && typeof l.until === "number") s.leaderBefore = { owner: str(l.owner), until: l.until };
  s.leader = { owner: str(owner), until: now + LEASE_MS };
  return { state: s, ok: true };
}

/** Events a scheduler instance that does not lead offers the leader: kept in `pendingEvents` (one per
 *  kind and key within EVENT_GAP_MS, at most MAX_PENDING_EVENTS), consumed by the next `round`. */
export function offerEvents(state, events, now) {
  const s = normalize(state);
  const pending = [...(s.pendingEvents ?? [])];
  for (const e of Array.isArray(events) ? events : []) {
    if (!isEvent(e)) continue;
    if (pending.some((p) => p.kind === e.kind && p.key === e.key && now - num(p.at) < EVENT_GAP_MS)) continue;
    pending.push({ kind: e.kind, key: e.key, title: str(e.title), url: str(e.url), at: now });
  }
  const kept = pending.slice(-MAX_PENDING_EVENTS);
  if (kept.length) s.pendingEvents = kept;
  else delete s.pendingEvents;
  return s;
}

/** The lease given up by its holder (a scheduler stopping), so another instance can lead at once. */
export function resign(state, owner) {
  const s = normalize(state);
  if (isObj(s.leader) && s.leader.owner === owner) delete s.leader;
  return s;
}

/** One scheduler round: apply `finished`, mark new routines seen, schedule, listen to `events`, start queued
 *  runs while fewer than `maxParallel` (default 3) run, time out. `owner` is the calling scheduler
 *  instance's token: the runs it claims carry it, and the state keeps the round's time in `ticked` with
 *  `tickedBy`. Only a previous round of the same instance tells that the scheduler kept running in
 *  between; the first round of an instance never counts a due time as on time. A `finished` entry with
 *  `id` ends only that run. A routine with `unavailable: true` (its file not readable this time) neither
 *  schedules nor starts, and keeps its queued jobs. `hold: true` starts nothing this round (queued jobs
 *  wait): for a caller that may not launch more now. */
export function round(state, routines, now, o = {}) {
  const s = normalize(state);
  const owner = typeof o?.owner === "string" && o.owner ? o.owner : null;
  const same = owner !== null && s.tickedBy === owner && typeof s.ticked === "number" && Number.isFinite(s.ticked) && s.ticked <= now;
  const prev = same ? s.ticked : null;
  const list = (Array.isArray(routines) ? routines : []).filter((r) => isObj(r) && typeof r.slug === "string");
  const bySlug = new Map(list.map((r) => [r.slug, r]));
  const out = { state: s, start: [], stop: [], notify: [], drop: [] };
  for (const f of Array.isArray(o?.finished) ? o.finished : []) if (isObj(f) && typeof f.slug === "string") finish(s, f, bySlug.get(f.slug), now, out);
  pruneCosts(s, now);
  for (const r of list) {
    const m = s.marks[r.slug];
    if (!isObj(m) || typeof m.seen !== "number") s.marks[r.slug] = { seen: now, fired: 0 };
  }
  schedule(s, list, now, prev, out);
  // Events offered by other instances first, then the caller's; both go through the same de-duplication.
  const offered = s.pendingEvents ?? [];
  delete s.pendingEvents;
  listen(s, list, [...offered, ...(Array.isArray(o?.events) ? o.events : [])], now);
  const max = Number.isInteger(o?.maxParallel) && o.maxParallel > 0 ? o.maxParallel : DEFAULT_PARALLEL;
  if (o?.hold !== true) startQueued(s, bySlug, now, max, owner, out);
  timeOut(s, now, out);
  s.ticked = now;
  if (owner) s.tickedBy = owner;
  else delete s.tickedBy;
  return out;
}

/** Queues a run by hand; `ok` false when the routine runs or waits already. */
export function runNow(state, slug) {
  const s = normalize(state);
  if (typeof slug !== "string" || busy(s, slug)) return { state: s, ok: false };
  s.queued.push({ slug, why: { kind: "manual" }, event: null });
  return { state: s, ok: true };
}

/** Asks a routine's run to stop (it ends as `stopped`): marked `stopping`, and the leading scheduler's next
 *  round signals it (`round` → `stop`). `stop` is the run asked to stop, or null when it does not run. A
 *  queued run of that routine is dropped either way. */
export function requestStop(state, slug, now) {
  const s = normalize(state);
  s.queued = s.queued.filter((q) => q.slug !== slug);
  const run = s.running[slug];
  if (!isObj(run)) return { state: s, stop: null };
  if (typeof run.stopping !== "number") run.stopping = now;
  return { state: s, stop: { slug, id: run.id, kill: false } };
}

/** The started run's terminal address and worktree, once the caller launched it. */
export function started(state, slug, info) {
  const s = normalize(state);
  const run = s.running[slug];
  if (!isObj(run) || !isObj(info)) return s;
  if (typeof info.address === "string" && info.address) run.address = info.address;
  if (isObj(info.worktree)) run.worktree = clone(info.worktree);
  return s;
}

/** A run the caller could not launch: it ends at once as a failed record with `error`. */
export function startFailed(state, slug, now, error) {
  const s = normalize(state);
  const run = s.running[slug];
  if (!isObj(run)) return s;
  delete s.running[slug];
  record(s, slug, { id: run.id, started: run.started, ended: now, ok: false, code: null, why: run.why, summary: "", error: str(error) }, []);
  return s;
}

/** A routine's runs, costs, queue and marks gone with it. A run still going stays in `running`, asked to
 *  stop (`stopping` = `now`) and marked `forgotten`: the leading scheduler stops it, and its end leaves no
 *  record but a `drop` of its files. */
export function forget(state, slug, now) {
  const s = normalize(state);
  delete s.marks[slug];
  delete s.runs[slug];
  delete s.costs[slug];
  s.queued = s.queued.filter((q) => q.slug !== slug);
  const run = s.running[slug];
  if (isObj(run)) {
    run.forgotten = true;
    if (typeof run.stopping !== "number") run.stopping = typeof now === "number" && Number.isFinite(now) ? now : num(run.started);
  }
  return s;
}

/** What a routine's runs that started in the last seven days cost (USD): every run of the week, also
 *  those past the 20 records kept for display. */
export function spentWeek(state, slug, now) {
  if (!isObj(state)) return 0;
  const listed = own(state.runs, slug);
  const runs = Array.isArray(listed) ? { [slug]: listed.filter(isObj) } : {};
  const list = own(costsOf(isObj(state.costs) ? { costs: { [slug]: own(state.costs, slug) } } : {}, runs), slug) ?? [];
  let sum = 0;
  for (const c of list) if (now - c.at < WEEK_MS) sum += c.usd;
  return sum;
}

/** The next `n` times a routine runs on its own: an interval from its last run, a schedule's next times;
 *  none when paused, by hand, on events or broken. */
export function nextRuns(routine, state, now, n = 3) {
  if (!usable(routine) || routine.paused === true) return [];
  const m = isObj(own(own(state, "marks"), routine.slug)) ? own(state.marks, routine.slug) : null;
  const base = Math.max(typeof m?.seen === "number" ? m.seen : now, num(m?.fired));
  const out = [];
  if (routine.when.kind === "every") {
    const step = num(routine.when.secs) * 1000;
    if (step <= 0) return [];
    for (let i = 1; i <= n; i++) out.push(base + i * step);
  } else if (routine.when.kind === "cron") {
    let at = nextAfter(routine.when, Math.max(base, now));
    while (at !== null && out.length < n) {
      out.push(at);
      at = nextAfter(routine.when, at);
    }
  }
  return out;
}
