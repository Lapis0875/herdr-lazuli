// Routine files (`data/lazuli/routines/<slug>.md`): a front matter of `key: value` lines, then the prompt or
// the script; `when` says when it runs, in words or as cron (ARCHITECTURE §4.6). A port of cockpit 0.38.5
// `core/src/routines.rs`, so a cockpit routine file reads the same here. Pure: errors are codes, and every
// time is epoch ms read with local `Date` getters.

/** `on <trigger>` → the gh event kinds it covers (`sys/gh.js` makes them, `core/gh-map.js` diffEvents). */
export const TRIGGERS = Object.freeze({
  review: Object.freeze(["review_requested"]),
  approved: Object.freeze(["approved"]),
  changes: Object.freeze(["changes_requested"]),
  opened: Object.freeze(["pr_opened"]),
  merged: Object.freeze(["merged"]),
  "ci-failed": Object.freeze(["ci_failed"]),
  "ci-passed": Object.freeze(["ci_passed"]),
});

// Upstream triggers whose events only cockpit's hub made (trackers, releases, monitors).
const UNAVAILABLE = ["ticket", "assigned", "live", "release", "release-ok", "release-moved", "release-failed", "alert", "error"];

const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const ALL_WEEK = 0x7f;
const WEEKDAYS = 0b0111110;
const WEEKENDS = 0b1000001;
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const str = (v) => (typeof v === "string" ? v : "");
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const UINT = /^\+?\d+$/;

// Lines as Rust's `str::lines`: split on "\n", a trailing "\r" cut, no empty line after a final "\n".
function lines(text) {
  if (text === "") return [];
  const out = text.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  if (text.endsWith("\n")) out.pop();
  return out;
}

/** The `key: value` lines between two `---` lines at the top (keys trimmed and lower-cased), and the body
 *  after them, trimmed. Without a closed front matter: no fields and the text as it is. */
export function frontMatter(text) {
  const t = str(text);
  const all = lines(t);
  if (all.length === 0 || all[0].trim() !== "---") return { fields: [], body: t };
  const fields = [];
  const body = [];
  let inHead = true;
  for (const line of all.slice(1)) {
    if (!inHead) {
      body.push(line);
    } else if (line.trim() === "---") {
      inHead = false;
    } else {
      const colon = line.indexOf(":");
      if (colon >= 0) fields.push([line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]);
    }
  }
  if (inHead) return { fields: [], body: t };
  return { fields, body: body.join("\n").trim() };
}

/** The file's text with the field set (added at the end of the front matter when missing); the other
 *  fields and the body stay as they were. */
export function setField(text, key, value) {
  const { fields, body } = frontMatter(text);
  const out = ["---"];
  let set = false;
  for (const [k, v] of fields) {
    if (k === key) {
      out.push(`${key}: ${value}`);
      set = true;
    } else {
      out.push(`${k}: ${v}`);
    }
  }
  if (!set) out.push(`${key}: ${value}`);
  out.push("---", "", body);
  return `${out.join("\n")}\n`;
}

// "09:00", "9:30", "17h" → [hours, minutes].
function clock(text) {
  let h;
  let m;
  const colon = text.indexOf(":");
  if (colon >= 0) {
    h = text.slice(0, colon);
    m = text.slice(colon + 1);
  } else if (text.endsWith("h")) {
    h = text.slice(0, -1);
    m = "0";
  } else {
    return null;
  }
  if (!UINT.test(h) || !UINT.test(m)) return null;
  const [hh, mm] = [Number(h), Number(m)];
  return hh < 24 && mm < 60 ? [hh, mm] : null;
}

// "mon", "Monday", "mon-fri", "mon,thu" → day bits, Sunday first.
function weekdays(text) {
  const day = (name) => {
    const n = name.toLowerCase();
    const i = DAYS.findIndex((d) => n.length >= 3 && (d.startsWith(n) || n.startsWith(d)));
    return i < 0 ? null : i;
  };
  let bits = 0;
  for (const part of text.split(",").filter((p) => p !== "")) {
    const dash = part.indexOf("-");
    if (dash >= 0) {
      const [a, b] = [day(part.slice(0, dash)), day(part.slice(dash + 1))];
      if (a === null || b === null) return null;
      for (let d = a; ; d = (d + 1) % 7) {
        bits |= 1 << d;
        if (d === b) break;
      }
    } else {
      const d = day(part);
      if (d === null) return null;
      bits |= 1 << d;
    }
  }
  return bits !== 0 ? bits : null;
}

const UNITS = Object.freeze({ m: 60, min: 60, mins: 60, minute: 60, minutes: 60, h: 3600, hour: 3600, hours: 3600, d: 86400, day: 86400, days: 86400 });

// "30m", "30 min", "2h", "1 day" → seconds, a minute at least.
function interval(text) {
  const t = text.replace(/ /g, "");
  const m = /^(\d*)([\s\S]*)$/.exec(t);
  const n = m[1] === "" ? 1 : Number(m[1]);
  const unit = own(UNITS, m[2]) ? UNITS[m[2]] : null;
  if (!unit || !Number.isSafeInteger(n)) return null;
  const secs = n * unit;
  return secs >= 60 ? secs : null;
}

// One cron field: `a`, `a-b`, `*`, each with an optional `/step`, comma-separated → the sorted values.
function field(text, min, max) {
  const values = new Set();
  for (const part of text.split(",")) {
    const slash = part.indexOf("/");
    let rangeText = part;
    let step = 1;
    if (slash >= 0) {
      rangeText = part.slice(0, slash);
      const s = part.slice(slash + 1);
      step = UINT.test(s) ? Number(s) : 0;
      if (step <= 0) return { error: part };
    }
    const number = (s) => (UINT.test(s) && Number(s) >= min && Number(s) <= max ? Number(s) : null);
    let from;
    let to;
    if (rangeText === "*") {
      [from, to] = [min, max];
    } else {
      const dash = rangeText.indexOf("-");
      if (dash >= 0) [from, to] = [number(rangeText.slice(0, dash)), number(rangeText.slice(dash + 1))];
      else if (step > 1) [from, to] = [number(rangeText), max];
      else from = to = number(rangeText);
    }
    if (from === null || to === null || from > to) return { error: part };
    for (let n = from; n <= to; n += step) values.add(n);
  }
  return { values: [...values].sort((a, b) => a - b) };
}

function parseCron(text) {
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length !== 5) return { error: "cron-fields" };
  const [minute, hour, day, month, weekday] = parts;
  const out = { anyDay: day === "*", anyWeekday: weekday === "*" };
  for (const [name, t, min, max] of [["minutes", minute, 0, 59], ["hours", hour, 0, 23], ["days", day, 1, 31], ["months", month, 1, 12], ["weekdays", weekday, 0, 7]]) {
    const f = field(t, min, max);
    if (f.error !== undefined) return { error: "cron-field", detail: f.error };
    out[name] = f.values;
  }
  if (out.weekdays.includes(7)) out.weekdays = [...new Set([0, ...out.weekdays.filter((d) => d !== 7)])].sort((a, b) => a - b);
  return { cron: out };
}

// At these times of day on these days of the week.
function cronsAt(times, bits) {
  const days = range(0, 6).filter((d) => bits & (1 << d));
  return times.map(([h, m]) => ({ minutes: [m], hours: [h], days: range(1, 31), months: range(1, 12), weekdays: days, anyDay: true, anyWeekday: bits === ALL_WEEK }));
}

const whenError = (error, detail) => (detail === undefined ? { error } : { error, detail });

// Splits off the first word: [head, rest trimmed].
function headRest(text) {
  const m = /\s/.exec(text);
  return m ? [text.slice(0, m.index), text.slice(m.index).trim()] : [text, ""];
}

function timesIn(rest) {
  const words = rest.split(/[, ]/).filter((t) => t !== "" && t !== "at");
  const times = words.map(clock);
  return times.length && times.every(Boolean) ? times : null;
}

/** `manual`, `every 30m`, `hourly`, `daily 09:00`, `weekdays 9:00,17:30`, `mon,thu 14:00`, `cron m h dom mon dow`
 *  or `on <trigger> [words]`; empty is manual. Bad text → `{error, detail?}`. */
export function parseWhen(text) {
  const t = str(text).trim();
  const lower = t.toLowerCase();
  const [head, rest] = headRest(lower);
  const at = (bits) => {
    const times = timesIn(rest);
    return times ? { kind: "cron", crons: cronsAt(times, bits) } : whenError("when-time", rest);
  };
  switch (head) {
    case "":
    case "manual":
    case "never":
      return { kind: "manual" };
    case "hourly":
      return { kind: "every", secs: 3600 };
    case "every": {
      const secs = interval(rest);
      return secs === null ? whenError("when-duration", rest) : { kind: "every", secs };
    }
    case "daily":
    case "at":
      return at(ALL_WEEK);
    case "weekdays":
      return at(WEEKDAYS);
    case "weekends":
      return at(WEEKENDS);
    case "cron": {
      const c = parseCron(t.slice(4));
      return c.cron ? { kind: "cron", crons: [c.cron] } : whenError(c.error, c.detail);
    }
    case "on": {
      const words = rest.split(/\s+/).filter(Boolean);
      const trigger = words.shift() ?? "";
      if (trigger === "any") return { kind: "on", trigger, kinds: Object.values(TRIGGERS).flat(), words };
      if (own(TRIGGERS, trigger)) return { kind: "on", trigger, kinds: [...TRIGGERS[trigger]], words };
      return whenError(UNAVAILABLE.includes(trigger) ? "on-unavailable" : "on-unknown", trigger);
    }
    default: {
      const bits = weekdays(head);
      return bits === null ? whenError("when-unknown", head) : at(bits);
    }
  }
}

// Local wall-clock times as "naive" ms: Date.UTC of the local fields, so calendar steps never meet DST.
const MINUTE = 60000;
const DAY = 86400000;

function naive(ms) {
  const d = new Date(ms);
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds());
}

// A local wall-clock time (naive ms) → epoch ms. Policy for daylight-saving changes: a minute the clocks
// skip (spring forward) becomes the first minute that exists after the gap, so it runs once at the jump; a
// minute that occurs twice (fall back) is its first occurrence, and runs once.
function epoch(n) {
  const d = new Date(n);
  const t = new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes()).getTime();
  if (naive(t) === n) return t;
  // Skipped: the Date constructor moved it forward by the gap; walk from before the gap to its end.
  for (let u = Math.floor(t / MINUTE) * MINUTE - 3 * 3600000; u <= t; u += MINUTE) if (naive(u) >= n) return u;
  return t;
}

function cronOnDay(c, n) {
  const d = new Date(n);
  const day = c.days.includes(d.getUTCDate());
  const weekday = c.weekdays.includes(d.getUTCDay());
  let ok;
  if (c.anyDay && c.anyWeekday) ok = true;
  else if (c.anyDay) ok = weekday;
  else if (c.anyWeekday) ok = day;
  else ok = day || weekday;
  return ok && c.months.includes(d.getUTCMonth() + 1);
}

// The first minute the cron allows strictly after `after` (naive), within eight years.
function cronNext(c, after) {
  const start = Math.floor(after / MINUTE) * MINUTE + MINUTE;
  const startDay = Math.floor(start / DAY) * DAY;
  const startHour = new Date(start).getUTCHours();
  const startMinute = new Date(start).getUTCMinutes();
  const hours = [...c.hours].sort((a, b) => a - b);
  const minutes = [...c.minutes].sort((a, b) => a - b);
  let date = startDay;
  for (let i = 0; i < 8 * 366; i++, date += DAY) {
    if (!cronOnDay(c, date)) continue;
    const first = date === startDay;
    for (const hour of hours) {
      if (first && hour < startHour) continue;
      const fromMinute = first && hour === startHour ? startMinute : 0;
      const minute = minutes.find((m) => m >= fromMinute);
      if (minute !== undefined) return date + hour * 3600000 + minute * MINUTE;
    }
  }
  return null;
}

const CRON_FIELDS = ["minutes", "hours", "days", "months", "weekdays"];
const isCron = (c) => isObj(c) && CRON_FIELDS.every((f) => Array.isArray(c[f]) && c[f].every(Number.isInteger));
const validCrons = (when) => (isObj(when) && when.kind === "cron" && Array.isArray(when.crons) ? when.crons.filter(isCron) : null);

function nextNaive(crons, after) {
  let best = null;
  for (const c of crons) {
    const n = cronNext(c, after);
    if (n !== null && (best === null || n < best)) best = n;
  }
  return best;
}

/** The first time a schedule fires strictly after `after`, local time; null for anything but cron (an
 *  interval counts from its last run). Across daylight-saving changes see `epoch`. */
export function nextAfter(when, after) {
  const crons = validCrons(when);
  if (!crons || !Number.isFinite(after)) return null;
  let at = naive(after);
  for (let i = 0; i < 1500; i++) {
    const n = nextNaive(crons, at);
    if (n === null) return null;
    const e = epoch(n);
    if (e > after) return e;
    // A repeated wall-clock hour (fall back): its minutes are their first occurrence, before `after`.
    at = n;
  }
  return null;
}

// The last minute the cron allows at or before `end` and strictly after `after` (both naive), searching
// backward from `end`; null when none.
function cronPrev(c, end, after) {
  const top = Math.floor(end / MINUTE) * MINUTE;
  const topDay = Math.floor(top / DAY) * DAY;
  const topHour = new Date(top).getUTCHours();
  const topMinute = new Date(top).getUTCMinutes();
  const hours = [...c.hours].sort((a, b) => b - a);
  const minutes = [...c.minutes].sort((a, b) => b - a);
  let date = topDay;
  for (let i = 0; i < 8 * 366 && date + DAY > after; i++, date -= DAY) {
    if (!cronOnDay(c, date)) continue;
    const last = date === topDay;
    for (const hour of hours) {
      if (last && hour > topHour) continue;
      const toMinute = last && hour === topHour ? topMinute : 59;
      const minute = minutes.find((m) => m <= toMinute);
      if (minute === undefined) continue;
      const at = date + hour * 3600000 + minute * MINUTE;
      return at > after ? at : null;
    }
  }
  return null;
}

/** The last time a schedule was due in (after, now], or null: the latest matching minute, however long
 *  ago `after` is (searched backward from `now`), always with `after < result <= now` in real time.
 *  Across daylight-saving changes see `epoch`. */
export function lastDue(when, after, now) {
  const crons = validCrons(when);
  if (!crons || !Number.isFinite(after) || !Number.isFinite(now)) return null;
  const from = naive(after);
  // Just after a fall back the wall clock already read later than it reads now: search from there too.
  const offset = (t) => naive(t) - t;
  let end = naive(now) + Math.max(0, offset(now - 3 * 3600000) - offset(now));
  for (let i = 0; i < 1500; i++) {
    let best = null;
    for (const c of crons) {
      const at = cronPrev(c, end, from);
      if (at !== null && (best === null || at > best)) best = at;
    }
    if (best === null) return null;
    const e = epoch(best);
    if (e <= after) return null;
    if (e <= now) return e;
    end = best - MINUTE;
  }
  return null;
}

/** Whether a gh event `{kind, title}` sets off an `on` routine: its kind listed and every word in the title. */
export function setsOff(when, event) {
  if (!isObj(when) || when.kind !== "on" || !isObj(event)) return false;
  const kinds = Array.isArray(when.kinds) ? when.kinds : [];
  const words = Array.isArray(when.words) ? when.words : [];
  const title = str(event.title).toLowerCase();
  return kinds.includes(event.kind) && words.every((w) => title.includes(String(w)));
}

const capital = (w) => (w ? w[0].toUpperCase() + w.slice(1) : "");

/** How a `when` reads, as a catalog code and its values: `manual`, `every-min|every-hour|every-day {n}`,
 *  `cron {expr}`, `daily|weekdays|weekends {times}`, `days {days, times}`, `on {trigger, words}`, or
 *  `error {error, detail?}`. `text` is the `when` as written. */
export function describeWhen(when, text) {
  if (!isObj(when) || typeof when.error === "string") {
    const error = isObj(when) && typeof when.error === "string" ? when.error : "when-unknown";
    return { code: "error", vars: isObj(when) && when.detail !== undefined ? { error, detail: when.detail } : { error } };
  }
  switch (when.kind) {
    case "every": {
      const s = when.secs;
      if (s % 86400 === 0) return { code: "every-day", vars: { n: s / 86400 } };
      if (s % 3600 === 0) return { code: "every-hour", vars: { n: s / 3600 } };
      return { code: "every-min", vars: { n: Math.floor(s / 60) } };
    }
    case "cron": {
      const lower = str(text).trim().toLowerCase();
      const [head, rest] = headRest(lower);
      const times = rest
        .split(/[, ]/)
        .filter((t) => t !== "" && t !== "at")
        .map(clock)
        .filter(Boolean)
        .map(([h, m]) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`)
        .join(", ");
      if (head === "cron") return { code: "cron", vars: { expr: lower } };
      if (head === "daily" || head === "at") return { code: "daily", vars: { times } };
      if (head === "weekdays" || head === "weekends") return { code: head, vars: { times } };
      return { code: "days", vars: { days: head.split(",").map(capital).join(", "), times } };
    }
    case "on":
      return { code: "on", vars: { trigger: str(when.trigger), words: (Array.isArray(when.words) ? when.words : []).join(" ") } };
    default:
      return { code: "manual", vars: {} };
  }
}

// "2", "$2", "$1.50/week", "2 a week" → the leading amount, above zero.
function dollars(text) {
  const t = text.trim().replace(/^\$+/, "");
  const lead = /^[0-9.]*/.exec(t)[0];
  if (lead === "") return null;
  const n = Number(lead);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Minutes a missed scheduled run may still start late: `2h`, `90m`, `30`; `never`/`no`/`off`/`-1`/`0` → 0; 12 h by default.
function catchUp(text) {
  const t = text.trim().toLowerCase();
  if (t === "") return 720;
  if (["never", "no", "off", "-1", "0"].includes(t)) return 0;
  const secs = interval(t) ?? interval(`${t}m`);
  return secs === null ? 720 : Math.floor(secs / 60);
}

/** One routine as its file says (upstream `Routine::parse`). A leading `~` in `cwd` becomes `o.home`. */
export function parseRoutine(slug, path, text, o) {
  const { fields, body } = frontMatter(text);
  const get = (key) => {
    for (let i = fields.length - 1; i >= 0; i--) if (fields[i][0] === key) return fields[i][1];
    return "";
  };
  const truthy = (key) => ["true", "yes", "on", "1"].includes(get(key).toLowerCase());
  const s = str(slug);
  const cwd = get("cwd");
  const timeoutText = get("timeout").replace(/m+$/, "").trim();
  const timeout = UINT.test(timeoutText) && Number(timeoutText) > 0 ? Number(timeoutText) : 30;
  const notify = get("notify").toLowerCase();
  const whenText = get("when");
  return {
    slug: s,
    path: str(path),
    name: get("name") || s.replace(/-/g, " "),
    whenText,
    when: parseWhen(whenText),
    run: get("run").toLowerCase() === "shell" ? "shell" : "agent",
    agent: get("agent").toLowerCase(),
    body,
    cwd: cwd.startsWith("~") ? `${str(o?.home)}${cwd.slice(1)}` : cwd,
    model: get("model"),
    tools: get("tools").split(",").map((t) => t.trim()).filter(Boolean),
    mode: get("mode"),
    budget: dollars(get("budget")),
    timeout,
    notify: ["never", "no", "off"].includes(notify) ? "never" : ["failed", "failures", "errors"].includes(notify) ? "failed" : "always",
    paused: truthy("paused"),
    worktree: truthy("worktree"),
    catchUp: catchUp(get("catch-up")),
  };
}

/** A file name from the name's words (at most six, lower-cased), not in `taken`. */
export function slugFor(name, taken) {
  const words = str(name).split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, 6).map((w) => w.toLowerCase());
  const base = words.length ? words.join("-") : "routine";
  const used = new Set(Array.isArray(taken) ? taken : []);
  let slug = base;
  for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
  return slug;
}

/** A new routine's file text. */
export function newFile(o) {
  const head = ["---", `name: ${str(o?.name).trim()}`, `when: ${str(o?.when).trim()}`];
  if (str(o?.cwd).trim() !== "") head.push(`cwd: ${str(o.cwd).trim()}`);
  head.push("---");
  return `${head.join("\n")}\n\n${str(o?.body).trim()}\n`;
}
