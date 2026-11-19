// The time agents spend working, per ticket (ARCHITECTURE §4.2, CONTRACTS ledger.js), in the format of cockpit v0.38.5
// `agents/src/ledger.rs`: each stretch an agent works is a line of ledger.jsonl {start, end, ticket, terminal}, written
// when it stops and every minute while it goes on, so a restart loses little. Two agents on one ticket at once count
// once. Pure: `now` is an argument, local days come from Date's local getters.

/** A stretch still going is written every minute. */
export const CHECKPOINT_MS = 60000;
/** Lines older than this go when the file is rewritten. */
export const KEEP_MS = 35 * 86400000;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v) => typeof v === "number" && Number.isFinite(v);
const text = (v) => (typeof v === "string" ? v : "");

/** One look at who works on what. `open` holds the stretches going on ({[terminal]: {start, ticket}}), `working` the
 *  agents working now. A terminal no longer working, or working on another ticket, closes its stretch; one going for
 *  CHECKPOINT_MS is written and goes on from now. Returns the new `open` and the stretches to write. */
export function tick(open, working, now) {
  const done = [];
  const next = {};
  const busy = (Array.isArray(working) ? working : []).filter((w) => isObj(w) && typeof w.terminal === "string" && w.terminal !== "");
  for (const [terminal, o] of Object.entries(isObj(open) ? open : {})) {
    if (!isObj(o) || !num(o.start)) continue;
    const ticket = text(o.ticket);
    if (busy.some((w) => w.terminal === terminal && text(w.ticket) === ticket)) next[terminal] = { start: o.start, ticket };
    else done.push({ start: o.start, end: now, ticket, terminal });
  }
  for (const w of busy) {
    const entry = next[w.terminal] ?? (next[w.terminal] = { start: now, ticket: text(w.ticket) });
    if (now - entry.start >= CHECKPOINT_MS) {
      done.push({ start: entry.start, end: now, ticket: entry.ticket, terminal: w.terminal });
      entry.start = now;
    }
  }
  return { open: next, done };
}

/** The stretches of a ledger.jsonl text that end after `since`; lines that are not a stretch are skipped. */
export function parseLedger(text_, since = 0) {
  if (typeof text_ !== "string") return [];
  const out = [];
  for (const line of text_.split("\n")) {
    if (!line.trim()) continue;
    let v;
    try {
      v = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isObj(v) || !num(v.start) || !num(v.end) || !(v.end > since)) continue;
    out.push({ start: v.start, end: v.end, ticket: text(v.ticket), terminal: text(v.terminal) });
  }
  return out;
}

/** Stretches as ledger.jsonl lines, each ending in "\n"; empty ones (end <= start) are left out. */
export function formatStretches(list) {
  let out = "";
  for (const s of Array.isArray(list) ? list : []) {
    if (!isObj(s) || !num(s.start) || !num(s.end) || s.end <= s.start) continue;
    out += `${JSON.stringify({ start: s.start, end: s.end, ticket: text(s.ticket), terminal: text(s.terminal) })}\n`;
  }
  return out;
}

/** The same stretches in fewer lines: one terminal's stretches on one ticket that touch or overlap (the minute
 *  checkpoints of one long stretch) become one, so totals stay the same. Sorted by start, then terminal and ticket;
 *  empty and malformed stretches are left out. */
export function mergeStretches(list) {
  const valid = (Array.isArray(list) ? list : [])
    .filter((s) => isObj(s) && num(s.start) && num(s.end) && s.end > s.start)
    .map((s) => ({ start: s.start, end: s.end, ticket: text(s.ticket), terminal: text(s.terminal) }));
  const byKey = new Map();
  for (const s of valid) {
    const key = `${s.terminal}\u0000${s.ticket}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(s);
  }
  const out = [];
  for (const group of byKey.values()) {
    group.sort((a, b) => a.start - b.start || a.end - b.end);
    let cur = null;
    for (const s of group) {
      if (cur && s.start <= cur.end) cur.end = Math.max(cur.end, s.end);
      else {
        if (cur) out.push(cur);
        cur = { ...s };
      }
    }
    if (cur) out.push(cur);
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return out.sort((a, b) => a.start - b.start || cmp(a.terminal, b.terminal) || cmp(a.ticket, b.ticket));
}

/** The time the intervals cover inside [from, to), overlaps counted once, in whole seconds. */
export function covered(intervals, from, to) {
  const clipped = (Array.isArray(intervals) ? intervals : [])
    .filter((iv) => Array.isArray(iv) && num(iv[0]) && num(iv[1]))
    .map(([s, e]) => [Math.max(s, from), Math.min(e, to)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let total = 0;
  let cur = null;
  for (const [s, e] of clipped) {
    if (cur && s <= cur[1]) cur[1] = Math.max(cur[1], e);
    else {
      if (cur) total += cur[1] - cur[0];
      cur = [s, e];
    }
  }
  if (cur) total += cur[1] - cur[0];
  return Math.floor(total / 1000);
}

/** Local midnight of the day holding `now`, and the Monday that starts its week, in ms. */
export function dayAndWeekStart(now) {
  const d = new Date(now);
  if (Number.isNaN(d.getTime())) return { day: 0, week: 0 };
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const week = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime();
  return { day, week };
}

const pad = (n) => String(n).padStart(2, "0");
const localDate = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** Seconds per ticket today and this week (Monday to Sunday, local), per terminal today (any ticket, none included),
 *  the week's days (YYYY-MM-DD) and per ticket its seconds on each. Tickets with no time this week are left out. */
export function totals(list, now) {
  const { day: today, week: monday } = dayAndWeekStart(now);
  const byTicket = new Map();
  const agents = {};
  for (const s of Array.isArray(list) ? list : []) {
    if (!isObj(s) || !num(s.start) || !num(s.end)) continue;
    const ticket = text(s.ticket);
    const terminal = text(s.terminal);
    if (ticket) {
      if (!byTicket.has(ticket)) byTicket.set(ticket, []);
      byTicket.get(ticket).push([s.start, s.end]);
    }
    agents[terminal] = (agents[terminal] ?? 0) + covered([[s.start, s.end]], today, now + 1);
  }
  const m = new Date(monday);
  const starts = Array.from({ length: 8 }, (_, i) => new Date(m.getFullYear(), m.getMonth(), m.getDate() + i).getTime());
  const days = starts.slice(0, 7).map(localDate);
  const tickets = {};
  const week = {};
  for (const key of [...byTicket.keys()].sort()) {
    const iv = byTicket.get(key);
    const w = covered(iv, monday, now + 1);
    if (w === 0) continue;
    tickets[key] = { today: covered(iv, today, now + 1), week: w };
    week[key] = starts.slice(0, 7).map((s, i) => covered(iv, s, starts[i + 1]));
  }
  return { tickets, agents, days, week };
}
