// The prompt-queue service (ARCHITECTURE §4.7): data/lazuli/queue.json read into the `queue` store (and its snapshot),
// the edits of core/queue-doc.js written back with writeTextFile(path, text, previous) (a stale write reads the file
// again and applies the edit once more), and delivery: the prompt goes to the agent with `hc send`; when it does not
// take it, the items go back where they were (cockpit v0.38.5 `cli/src/queue.rs` `act`).
//
// Who gets a prompt. The queue is per terminal (cockpit's): an item remembers the agent it was queued for, `agent:
// {app, pid}` (the program and the pid in the terminal's foreground). Right before `hc send` the terminal must show an
// agent: listed by agents(), not at its shell (a shell would run the prompt as a command), the item's app (any agent
// for an item without one: cockpit's, or older). The pid may differ: an agent restarted in the same terminal takes
// its queue. Otherwise nothing is typed and the items go back ("not-agent").
//
// Delivery never leaves prompts only in memory. One write takes the items out of their queue and records them as an
// in-flight delivery in the same file: `inflight: [{id, address, items, slots, at}]` (`slots`: where each item stood).
// After the send one more write drops the record (sent) or puts the items back (not sent). A record still in the file
// that no delivery of this run owns (Herdr quit in between, or that last write failed) is "interrupted": the store lists
// it, nothing resends it, and restoreInterrupted(id) or dropInterrupted(id) settles it. `inflight` and `agent` are
// written only when there is one, so the file is otherwise cockpit's format.
//
// Ids are unique across the file, and each is one the edits can name: queue-doc.js trims the id it is given and reads
// "" and "all" as the whole queue. On load an id with white space around it is trimmed, a blank one becomes
// `q-blank` and "all" becomes `q-all`; then a repeated one (cockpit's `q<ms>-<n>` can repeat after a removal) keeps
// its first occurrence, in queue then list order, then the in-flight records, and each later one becomes `<id>~2`,
// `<id>~3`, ... A new item whose id is taken gets the same suffix. Sending one item (send) and the whole queue
// (sendAll) are separate operations: no id stands for "all".
//
// Edits resolve with `{note, texts}` (queue-doc.js notes; `texts`: what was delivered) or `{error}`: queue-doc.js
// errors, and
//   "not-agent"       `add`: no live agent at the address; send: the address shows no agent of the items' app (gone,
//                     at its shell, or another app): nothing typed, the items are back in the queue
//   "not-taken"       hc send failed (the agent waits on a question, or is gone); the items are back in the queue
//   "not-restored"    not sent and the items could not be put back: `{error, id}`, listed under `interrupted`
//   "corrupt"         the file is damaged: nothing is written until resetCorrupt()
//   "write-failed"    "stale" (the file changed underneath twice)   "not-interrupted" (no such interrupted delivery)
// The store value: {version: 1, queues: {address: [{id, text, at, agent?}]}, count, corrupt, interrupted: [{id,
// address, items, at}]}; while `corrupt` is true, queues and interrupted show empty. ⌥⌘Q (`lazuli.queue`, owned by
// the `status` copy) opens the queue dialog for the focused agent.
//
// Damaged: not readable as text (not UTF-8, over readTextFile's 1 MiB), not JSON, not a version-1 queue document, or
// holding an entry this service would drop. Rewriting such a file would lose what it holds, so edits refuse it and
// resetCorrupt() sets aside exactly the bytes it judged damaged (a file not readable as text is only copied: the
// person removes or repairs it).

import * as fs from "fs/promises";
import { Buffer } from "buffer";
import { agents, checking, focused, hc, openOverlay, readTextFile, terminals, writeTextFile } from "herdr";
import * as queue from "../core/queue-doc.js";
import { handle } from "./bus.js";
import { MOD, STORE } from "./state.js";
import * as store from "./store.js";
import { migrated } from "./migrate.js";

const log = (msg) => console.log(`[lazuli/queue] ${msg}`);
const errText = (e) => e?.message ?? String(e);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
// A key such as "__proto__" stays an own property instead of setting the prototype.
const put = (obj, key, value) => Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
// Arguments and ids read as queue-doc.js reads them (Unicode white space trimmed), so both agree on queue and item.
const EDGES = /^\p{White_Space}+|\p{White_Space}+$/gu;

/** The dialog's size (the reference mod's). */
const DIALOG = { width: 460, height: 440 };
/** What readTextFile reads at most. */
const MAX_TEXT = 1048576;

/** `<app home>/data/lazuli/queue.json`. */
export const queuePath = () => `${store.dataDir()}/queue.json`;

let published = null;
let started = false;
/** Deliveries of this run still between their two writes: their records are not interrupted. */
const active = new Set();
let deliveries = 0;

// One read or edit at a time, in call order, none before the migration settled: it writes data/lazuli/queue.json
// only while that file is absent (§7). A delivery waits for hc send outside the chain.
let chain = null;
function serial(fn) {
  chain ??= Promise.resolve().then(migrated).catch(() => {});
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

const empty = () => ({ version: 1, queues: {}, count: 0, corrupt: false, interrupted: [] });
const listOf = (doc, address) => (own(doc.queues, address) ? doc.queues[address] : []);

function publish(doc, inflight, corrupt = false) {
  const interrupted = inflight.filter((d) => !active.has(d.id)).map(({ id, address, items, at }) => ({ id, address, items, at }));
  const value = { version: 1, queues: doc.queues, count: queue.count(doc), corrupt, interrupted };
  const sig = JSON.stringify(value);
  if (sig === published && store.has(STORE.queue)) return;
  published = sig;
  store.set(STORE.queue, value);
}

// The agent at an address.

const baseName = (s) => (typeof s === "string" ? s.slice(s.lastIndexOf("/") + 1) : "");

/** The agent the terminal at `address` shows now, `{app, pid}`: agents() lists it with an agent app (its report, else
 *  its program's key), and the process in front is not its shell. The terminal's own process in front is the agent
 *  only when it was started as the agent itself (`hc run -- claude`): its name is that app or program key; anything
 *  else there is a shell prompt. Null otherwise, also when the foreground process is unknown. */
function agentAt(address) {
  const a = agents().find((x) => x.address === address);
  if (!a || a.program?.shell === true) return null;
  const key = a.program?.agent === true && typeof a.program.key === "string" ? a.program.key : null;
  const app = (typeof a.app === "string" && a.app) || key;
  const t = terminals().find((x) => x.address === address);
  const fg = t?.foreground;
  if (!app || !Number.isInteger(fg?.pid) || fg.pid <= 0) return null;
  if (fg.pid === t.pid) {
    const names = [fg.name, baseName(fg.argv?.[0])].filter((n) => typeof n === "string" && n !== "");
    if (!names.some((n) => n === app || n === key)) return null;
  }
  return { app, pid: fg.pid };
}

/** Whether the items may go to `now`, the agent at their address: an agent of each item's app (any for one without). */
const fitsAgent = (items, now) => now !== null && items.every((i) => !i.agent || i.agent.app === now.app);

// Reading and checking the file.

const isAgent = (v) => isPlain(v) && typeof v.app === "string" && v.app !== "" && Number.isInteger(v.pid) && v.pid > 0;

/** Whether every entry of `list` is a queue item normalize() keeps, with a well-formed `agent` when it has one. */
function allItems(list) {
  if (!Array.isArray(list)) return false;
  const kept = queue.normalize({ queues: { q: list } }).queues;
  return (own(kept, "q") ? kept.q.length : 0) === list.length && list.every((i) => i.agent === undefined || isAgent(i.agent));
}

const itemOf = (v) => ({ id: v.id, text: v.text, at: v.at, ...(v.agent ? { agent: { app: v.agent.app, pid: v.agent.pid } } : {}) });

const isRecord = (d) =>
  isPlain(d) &&
  typeof d.id === "string" &&
  d.id !== "" &&
  typeof d.address === "string" &&
  d.address !== "" &&
  typeof d.at === "number" &&
  Number.isFinite(d.at) &&
  allItems(d.items) &&
  d.items.length > 0 &&
  Array.isArray(d.slots) &&
  d.slots.length === d.items.length &&
  d.slots.every((s) => Number.isInteger(s) && s >= 0);

/** Why a file's parsed JSON is no queue document lazuli can rewrite without loss, or null when it is one. */
function damageOf(raw) {
  if (!isPlain(raw)) return "not a document";
  if (raw.version !== undefined && raw.version !== 1) return `version ${JSON.stringify(raw.version)}`;
  if (raw.queues !== undefined) {
    if (!isPlain(raw.queues)) return "queues is not an object";
    for (const handle of Object.keys(raw.queues)) {
      if (!allItems(raw.queues[handle])) return `queue ${handle} holds a bad entry`;
    }
  }
  if (raw.inflight !== undefined) {
    if (!Array.isArray(raw.inflight) || !raw.inflight.every(isRecord)) return "inflight holds a bad entry";
    if (new Set(raw.inflight.map((d) => d.id)).size !== raw.inflight.length) return "inflight repeats an id";
  }
  return null;
}

/** `id` itself when not taken, else `<id>~2`, `<id>~3`, ...: the first one free. Adds the result to `taken`. */
function freeId(id, taken) {
  let next = id;
  for (let n = 2; taken.has(next); n++) next = `${id}~${n}`;
  taken.add(next);
  return next;
}

/** An id as one the edits can name: trimmed, and never blank or "all" (queue-doc.js's whole-queue forms). */
function nameable(id) {
  const trimmed = id.replace(EDGES, "");
  return trimmed === "" ? "q-blank" : trimmed === "all" ? "q-all" : trimmed;
}

/** A checked document → `{doc, inflight}`, every item copied and its id nameable and unique across the file. */
function build(raw) {
  const taken = new Set();
  const fresh = (v) => ({ ...itemOf(v), id: freeId(nameable(v.id), taken) });
  const queues = {};
  for (const handle of Object.keys(raw.queues ?? {})) {
    const list = raw.queues[handle].map(fresh);
    if (list.length > 0) put(queues, handle, list);
  }
  const inflight = (raw.inflight ?? []).map((d) => ({ id: d.id, address: d.address, items: d.items.map(fresh), slots: d.slots.slice(), at: d.at }));
  return { doc: { version: 1, queues }, inflight };
}

/** A file's text → `{corrupt: false, doc, inflight}` or `{corrupt: true}` (logged). */
function classify(text) {
  let raw;
  let damage;
  try {
    raw = JSON.parse(text);
    damage = damageOf(raw);
  } catch {
    damage = "not JSON";
  }
  if (damage) {
    log(`${queuePath()} damaged (${damage}): edits refused until resetCorrupt()`);
    return { corrupt: true };
  }
  return { corrupt: false, ...build(raw) };
}

/** The file → `{text, doc, inflight, corrupt}`: text null when absent; a damaged file gives corrupt true, no queues
 *  and no records. */
async function readDoc() {
  const none = (text, corrupt) => ({ text, doc: queue.emptyDoc(), inflight: [], corrupt });
  let text;
  try {
    text = await readTextFile(queuePath());
  } catch (e) {
    log(`${queuePath()} unreadable as text: ${errText(e)}`);
    return none(null, true);
  }
  if (text === null) return none(null, false);
  const c = classify(text);
  return c.corrupt ? none(text, true) : { text, doc: c.doc, inflight: c.inflight, corrupt: false };
}

const fileText = (doc, inflight) => `${JSON.stringify({ version: 1, queues: doc.queues, ...(inflight.length ? { inflight } : {}) }, null, 2)}\n`;
const sameState = (a, b) => JSON.stringify([a.doc.queues, a.inflight]) === JSON.stringify([b.doc.queues, b.inflight]);
const idsOf = (doc, inflight = []) => new Set([...Object.values(doc.queues).flat(), ...inflight.flatMap((d) => d.items)].map((i) => i.id));

async function readNow() {
  const disk = await readDoc();
  publish(disk.doc, disk.inflight, disk.corrupt);
  return get();
}

/** One change of the file read fresh: `fn({doc, inflight})` → `{doc, inflight?, ...}` (returned as it is; inflight
 *  kept when absent) or `{error}`. Written only when something changes. */
async function mutate(fn) {
  const path = queuePath();
  for (let attempt = 0; ; attempt++) {
    const disk = await readDoc();
    if (disk.corrupt) {
      publish(disk.doc, disk.inflight, true);
      return { error: "corrupt" };
    }
    const r = fn({ doc: disk.doc, inflight: disk.inflight });
    if (r.error) {
      publish(disk.doc, disk.inflight);
      return r;
    }
    const next = { doc: r.doc, inflight: r.inflight ?? disk.inflight };
    if (sameState(next, disk)) {
      publish(disk.doc, disk.inflight);
      return r;
    }
    try {
      await fs.mkdir(store.dataDir(), { recursive: true });
      await writeTextFile(path, fileText(next.doc, next.inflight), disk.text);
    } catch (e) {
      let now;
      try {
        now = await readTextFile(path);
      } catch {
        now = disk.text;
      }
      if (now === disk.text) {
        log(`not written: ${errText(e)}`);
        return { error: "write-failed" };
      }
      if (attempt === 0) continue;
      return { error: "stale" };
    }
    publish(next.doc, next.inflight);
    return r;
  }
}

/** queue-doc.js `edit`'s result doc with what it drops carried over: each item keeps its `agent` (ids are unique), and
 *  an item `add` made (the last of its queue) gets a free id and `added.agent`. */
function carry(before, after, inflight, added) {
  const agentById = new Map(Object.values(before.queues).flat().map((i) => [i.id, i.agent]));
  const taken = idsOf(before, inflight);
  const queues = {};
  for (const handle of Object.keys(after.queues)) {
    const list = after.queues[handle].map((i) => ({ ...i }));
    if (added && handle === added.address) {
      const last = list[list.length - 1];
      last.id = freeId(last.id, taken);
      last.agent = added.agent;
    }
    for (const item of list) {
      const agent = item.agent ?? agentById.get(item.id);
      if (agent) item.agent = { app: agent.app, pid: agent.pid };
    }
    put(queues, handle, list);
  }
  return { version: 1, queues };
}

/** A recorded delivery's items put back in its agent's queue at the places they held; an id taken meanwhile is
 *  replaced by a free one. The record leaves the file in the same write, so nothing comes back twice. */
function restore(doc, inflight, record) {
  const taken = idsOf(doc, inflight.filter((d) => d.id !== record.id));
  const list = listOf(doc, record.address).slice();
  record.items.forEach((item, k) => {
    list.splice(Math.min(record.slots[k], list.length), 0, { ...item, id: freeId(item.id, taken) });
  });
  const queues = { ...doc.queues };
  put(queues, record.address, list);
  return { version: 1, queues };
}

const argOf = (args, i) => (Array.isArray(args) && typeof args[i] === "string" ? args[i].replace(EDGES, "") : "");
const addressOf = (args) => argOf(args, 0);

/** The second write of a delivery: its record dropped, and its items back in the queue unless they were sent. */
function settle(id, sent) {
  return serial(() =>
    mutate(({ doc, inflight }) => {
      const record = inflight.find((d) => d.id === id);
      const rest = inflight.filter((d) => d.id !== id);
      return { doc: record && !sent ? restore(doc, inflight, record) : doc, inflight: rest };
    }),
  );
}

/** One item (`which`: its id) or the whole queue (`which` null) delivered: the items leave the queue and are recorded
 *  in flight in one write; then, if the address shows an agent of their app, `hc send` types the prompt; a second
 *  write drops the record (sent) or puts the items back (not sent). */
async function deliver(rawAddress, which) {
  const address = typeof rawAddress === "string" ? rawAddress.replace(EDGES, "") : "";
  const id = `d${Date.now()}-${deliveries++}`;
  active.add(id);
  const r = await serial(() =>
    mutate(({ doc, inflight }) => {
      if (address === "") return { error: "no-agent" };
      const before = listOf(doc, address);
      let slots = before.map((_, slot) => slot);
      if (which !== null) {
        const slot = typeof which === "string" ? before.findIndex((i) => i.id === which) : -1;
        if (slot < 0) return { error: "not-in-queue" };
        slots = [slot];
      }
      // queue-doc.js's own form: the id, or "all" for the whole queue (no item is named "all" or blank, see build()).
      const now = Date.now();
      const e = queue.edit(doc, "send", [address, which ?? "all"], now);
      if (e.error) return e;
      // Nothing to send: the file stays as read (queue-doc.js's doc lacks every item's `agent`).
      if (e.texts.length === 0) return { doc, note: e.note, texts: [] };
      const items = slots.map((slot) => before[slot]);
      const record = { id, address, items, slots, at: now };
      return { doc: carry(doc, e.doc, inflight, null), note: e.note, texts: items.map((i) => i.text), record, inflight: [...inflight, record] };
    }),
  );
  if (r.error || r.texts.length === 0) {
    active.delete(id);
    return r.error ? { error: r.error } : { note: r.note, texts: [] };
  }
  let refused = null;
  let taken = false;
  // Known limitation, accepted: this check and `hc send` are two operations, so the agent can exit (or another of
  // the same app take the terminal, which is allowed by design) in between.
  if (!fitsAgent(r.record.items, agentAt(address))) {
    refused = "not-agent";
    log(`${address} does not show the agent its prompts were queued for: not sent`);
  } else {
    try {
      const sent = await hc(["send", address, "--", queue.prompt(r.texts)]);
      taken = sent.code === 0;
      if (!taken) log(`hc send ${address} exited ${sent.code}: ${sent.stderr.trim()}`);
    } catch (e) {
      log(`hc send ${address} failed: ${errText(e)}`);
    }
  }
  const settled = await settle(id, taken);
  active.delete(id);
  if (settled.error) {
    // The record stays in the file: from now on it lists as interrupted.
    log(`delivery ${id} to ${address} not settled (${taken ? "sent" : "not sent"}): ${settled.error}`);
    await reload();
  }
  if (taken) return { note: r.note, texts: r.texts };
  if (settled.error) return { error: "not-restored", id };
  return { error: refused ?? "not-taken" };
}

/** One queue edit with its args, as queue-doc.js `edit` takes them: `add [h, text]`, `edit [h, id, text]`,
 *  `remove [h, id]`, `move [h, id, to]`, `clear [h]`. `add` needs a live agent at `h` and remembers its app.
 *  Deliveries are send() and sendAll(): `send` here gives "unknown-action". */
export async function act(action, args) {
  if (action === "send") return { error: "unknown-action" };
  const address = addressOf(args);
  const agent = action === "add" && address !== "" ? agentAt(address) : null;
  const r = await serial(() =>
    mutate(({ doc, inflight }) => {
      const e = queue.edit(doc, action, args, Date.now());
      if (e.error) return e;
      if (e.note !== "queued") return { ...e, doc: carry(doc, e.doc, inflight, null) };
      if (!agent) return { error: "not-agent" };
      return { ...e, doc: carry(doc, e.doc, inflight, { address, agent }) };
    }),
  );
  return r.error ? { error: r.error } : { note: r.note, texts: r.texts };
}

/** A prompt queued for the agent at `address` (it must show an agent now). */
export const add = (address, text) => act("add", [address, text]);
/** A queued prompt's text changed. */
export const edit = (address, id, text) => act("edit", [address, id, text]);
/** A queued prompt dropped. */
export const remove = (address, id) => act("remove", [address, id]);
/** A queued prompt moved to index `to` of its queue. */
export const move = (address, id, to) => act("move", [address, id, to]);
/** Every prompt queued for the agent dropped. */
export const clear = (address) => act("clear", [address]);
/** The queued prompt with that id sent now. */
export const send = (address, id) => deliver(address, typeof id === "string" ? id : "");
/** Every prompt queued for the agent sent as one numbered prompt. */
export const sendAll = (address) => deliver(address, null);

/** One interrupted delivery settled: `put` true puts its items back in their queue, false drops them. */
async function settleInterrupted(id, put) {
  if (typeof id !== "string" || active.has(id)) return { error: "not-interrupted" };
  const r = await serial(() =>
    mutate(({ doc, inflight }) => {
      const record = active.has(id) ? null : inflight.find((d) => d.id === id);
      if (!record) return { error: "not-interrupted" };
      return { doc: put ? restore(doc, inflight, record) : doc, inflight: inflight.filter((d) => d.id !== id) };
    }),
  );
  return r.error ? { error: r.error } : { note: put ? "restored" : "dropped" };
}

/** An interrupted delivery's prompts put back in their agent's queue, where they stood (none is sent). Resolves with
 *  `{note: "restored"}` or `{error}` ("not-interrupted", "corrupt", "write-failed", "stale"). */
export const restoreInterrupted = (id) => settleInterrupted(id, true);

/** An interrupted delivery forgotten, its prompts with it. Resolves with `{note: "dropped"}` or `{error}` as
 *  restoreInterrupted. */
export const dropInterrupted = (id) => settleInterrupted(id, false);

/** The queues as the views draw them (the store value); no queues before the first read and with no snapshot. */
export function get() {
  return store.get(STORE.queue) ?? empty();
}

/** The prompts queued for one agent, in order. */
export function itemsFor(address) {
  const queues = get().queues;
  return typeof address === "string" && own(queues, address) ? queues[address] : [];
}

/** Reads the file again into the store. Resolves with the store value. */
export function reload() {
  return serial(readNow);
}

// Setting a damaged file aside.

const sameBytes = (a, b) => a.length === b.length && a.every((byte, i) => byte === b[i]);

/** Bytes → their text when they are UTF-8 that readTextFile reads, else null. */
function textOf(bytes) {
  if (bytes.length > MAX_TEXT) return null;
  try {
    const text = Buffer.from(bytes).toString("utf8");
    return sameBytes(Buffer.from(text, "utf8"), bytes) ? text : null;
  } catch {
    return null;
  }
}

const exists = (path) => fs.exists(path).catch(() => true);

/** A copy of `bytes` at `backup`, read back and compared; throws when that fails. */
async function copyTo(backup, bytes) {
  if (await exists(backup)) throw new Error(`${backup} exists`);
  await fs.writeFile(backup, bytes);
  if (!sameBytes(await fs.readFile(backup), bytes)) throw new Error(`${backup} differs from what was read`);
}

/** A damaged queue.json set aside, judged and kept from one read of its bytes, so a newer version is never lost:
 *  - text: copied byte for byte to `queue.json.corrupt-<ms>` (read back and compared), then the empty document
 *    written over it only if the file still holds exactly that text (writeTextFile's compare): `{note: "reset",
 *    backup}`;
 *  - not UTF-8 or over 1 MiB: only copied there (read back and compared); queue.json is left as it is for the person
 *    to remove or repair, and stays damaged until then: `{note: "backed-up", backup}`.
 *  Errors: "not-corrupt" (the file is absent or fine: nothing done), "read-failed", "write-failed" (the file stays; a
 *  verified copy may stay beside it), "stale" (the file changed after it was read: the newer one stays; the copy of
 *  the damaged one stays too). */
export function resetCorrupt() {
  return serial(async () => {
    const path = queuePath();
    let bytes;
    try {
      bytes = await fs.readFile(path);
    } catch (e) {
      if (!(await exists(path))) {
        publish(queue.emptyDoc(), [], false);
        return { error: "not-corrupt" };
      }
      log(`${path} not read: ${errText(e)}`);
      return { error: "read-failed" };
    }
    const text = textOf(bytes);
    const judged = text === null ? { corrupt: true } : classify(text);
    if (!judged.corrupt) {
      publish(judged.doc, judged.inflight, false);
      return { error: "not-corrupt" };
    }
    const backup = `${path}.corrupt-${Date.now()}`;
    try {
      await copyTo(backup, bytes);
    } catch (e) {
      log(`no copy of ${path}: ${errText(e)}`);
      return { error: "write-failed" };
    }
    if (text === null) {
      log(`${path} is not readable as text: a copy is at ${backup}; the file stays until it is removed or repaired`);
      publish(queue.emptyDoc(), [], true);
      return { note: "backed-up", backup };
    }
    try {
      await writeTextFile(path, fileText(queue.emptyDoc(), []), text);
    } catch (e) {
      let now;
      try {
        now = await readTextFile(path);
      } catch {
        now = undefined;
      }
      log(`${path} not replaced (${errText(e)}); the damaged copy stays at ${backup}`);
      return { error: now === text ? "write-failed" : "stale" };
    }
    log(`${path} damaged: kept as ${backup}, queues start empty`);
    publish(queue.emptyDoc(), [], false);
    return { note: "reset", backup };
  });
}

/** The agent the keyboard is on: the one an agent block shows, else the focused terminal when it is an agent; null
 *  otherwise. */
export function focusedAgent() {
  const f = focused();
  if (f?.agent) return f.agent;
  return f?.terminal && agents().some((a) => a.address === f.terminal) ? f.terminal : null;
}

/** Opens the queue dialog for the agent at `address`, else the focused one (`address: null` when there is none, so
 *  the dialog picks). Returns the overlay id. */
export function open(address) {
  const target = typeof address === "string" && address !== "" ? address : focusedAgent();
  return openOverlay({ mod: MOD, props: { view: "queue", address: target }, kind: "dialog", ...DIALOG });
}

handle("queue", () => {
  open();
});

/** Starts the service in the `status` copy (nothing during `herdr-app check`; again only after stop()): warm start
 *  from the snapshot, then the file read, which lists deliveries a previous run left in flight as interrupted. */
export function start(_cx) {
  if (started || checking()) return;
  started = true;
  store.load(STORE.queue).then(undefined, (e) => log(`snapshot not loaded: ${errText(e)}`));
  reload();
}

/** Lets a later start(cx) run anew. The service starts no timers or tasks; the queues, their store value, deliveries
 *  under way and the bus handler stay. */
export function stop() {
  started = false;
}
