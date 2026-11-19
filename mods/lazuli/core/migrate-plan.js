// The one-time move from lstack-herdr and cockpit to lazuli (DESIGN A9, ARCHITECTURE §7), as a plan of steps:
// what to copy, what to write, which terminal labels to rename, which cache to delete and the marker that says it
// ran. Pure: sys/migrate.js lists the inputs, runs the steps in order and writes the marker last.
//
// Only the pin names leave cockpit's config.json (it holds tokens): nothing else of it reaches a step or a count.

import { normalize, count } from "./queue-doc.js";
import { LABEL, OLD_LABEL, decodeRecord, encodeRecord } from "./resume-tools.js";

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isText = (v) => typeof v === "string" && v !== "";

// cockpit's app spaces that lazuli pins, by the name cockpit's config uses. cockpit itself calls the to-do app
// "to-do" in config.json and "todo" elsewhere (cli/src/doctor.rs, cli/src/focus.rs); both mean lazuli's "todo".
const PINS = Object.freeze({ inbox: "inbox", todo: "todo", "to-do": "todo", routines: "routines" });

/** The sidebar pins in cockpit's config: the `.spaces` names (strings or `{name}`) that are lazuli apps, in order,
 *  each once. null when the config has no `.spaces` list (lazuli keeps its default pins); [] when the list names no
 *  lazuli app (the person pinned none of them, so none is pinned). */
export function pinsFrom(config) {
  if (!isPlain(config) || !Array.isArray(config.spaces)) return null;
  const pins = [];
  for (const s of config.spaces) {
    const name = typeof s === "string" ? s : isPlain(s) && typeof s.name === "string" ? s.name : null;
    const pin = name !== null && Object.prototype.hasOwnProperty.call(PINS, name) ? PINS[name] : null;
    if (pin && !pins.includes(pin)) pins.push(pin);
  }
  return pins;
}

/** cockpit's queue document → lazuli's: the queues of `app:<address>` handles under `<address>`; other handles
 *  (another frontend's) are dropped, and so is everything `normalize` drops. */
export function queueFrom(doc) {
  const queues = isPlain(doc) && isPlain(doc.queues) ? doc.queues : {};
  const kept = Object.keys(queues)
    .filter((handle) => handle.startsWith("app:") && handle.length > 4)
    .map((handle) => [handle.slice(4), queues[handle]]);
  return normalize({ version: 1, queues: Object.fromEntries(kept) });
}

const zero = () => ({ todo: 0, routines: 0, pins: 0, queue: 0, labels: 0, cache: 0 });

/** The steps of one migration run, in the order they run: to-do, routines, pins, queue, labels, cache, marker.
 *  `done` (the marker exists) plans nothing. A target that exists is never overwritten. */
export function plan(i) {
  const o = isPlain(i) ? i : {};
  const counts = zero();
  const steps = [];
  const { home, appHome } = o;
  if (o.done !== false || !isText(home) || !home.startsWith("/") || !isText(appHome) || !appHome.startsWith("/")) {
    return { steps, counts };
  }
  const from = `${home}/.config/cockpit`;
  const to = `${appHome}/data/lazuli`;

  const todo = isPlain(o.todo) ? o.todo : {};
  if (todo.exists === true && todo.targetExists !== true) {
    steps.push({ op: "copy", from: `${from}/todo.md`, to: `${to}/todo.md` });
    counts.todo = 1;
  }

  const routines = isPlain(o.routines) ? o.routines : {};
  const existing = new Set(Array.isArray(routines.existing) ? routines.existing : []);
  const names = Array.isArray(routines.names) ? routines.names : [];
  const copies = [...new Set(names)]
    .filter((n) => isText(n) && !n.startsWith(".") && !n.includes("/") && n.endsWith(".md") && !existing.has(n))
    .sort();
  for (const name of copies) steps.push({ op: "copy", from: `${from}/routines/${name}`, to: `${to}/routines/${name}` });
  counts.routines = copies.length;

  // An empty selection is a choice too: [] leaves the sidebar with no pins, null keeps lazuli's default pins.
  const pins = pinsFrom(o.config);
  if (pins !== null) {
    steps.push({ op: "pins", pins });
    counts.pins = pins.length;
  }

  const queue = isPlain(o.queue) ? o.queue : {};
  const doc = queueFrom(queue.doc);
  const waiting = count(doc);
  if (waiting > 0 && queue.targetExists !== true) {
    steps.push({ op: "write-json", to: `${to}/queue.json`, value: doc });
    counts.queue = waiting;
  }

  const seen = new Set();
  for (const t of Array.isArray(o.terminals) ? o.terminals : []) {
    const labels = isPlain(t) && isPlain(t.labels) ? t.labels : {};
    const old = labels[OLD_LABEL];
    if (!isPlain(t) || !isText(t.address) || seen.has(t.address) || !isText(old)) continue;
    seen.add(t.address);
    // A record lazuli already wrote is newer than the old one. A record that decodes is written in the current form,
    // which drops credential options (resume-tools.js); anything else moves as it is.
    const chosen = isText(labels[LABEL]) ? labels[LABEL] : old;
    const record = decodeRecord(chosen);
    const value = record ? encodeRecord(record) : chosen;
    steps.push({ op: "label", address: t.address, key: LABEL, value, clear: OLD_LABEL });
    counts.labels += 1;
  }

  if (o.cacheExists === true) {
    steps.push({ op: "rm", path: `${home}/.cache/lstack-herdr` });
    counts.cache = 1;
  }

  const pendingMachines = Array.isArray(o.pendingMachines) ? o.pendingMachines.filter((m) => typeof m === "string") : [];
  const at = typeof o.now === "number" && Number.isFinite(o.now) ? o.now : null;
  steps.push({ op: "marker", to: `${to}/migrated.json`, value: { version: 1, at, counts: { ...counts }, pendingMachines } });
  return { steps, counts };
}
