// The one-time move from lstack-herdr and cockpit (DESIGN A9, ARCHITECTURE §7): lists the inputs, runs the plan of
// core/migrate-plan.js step by step and writes `data/lazuli/migrated.json` last. A failed step writes no marker, so
// the next start runs it again; every step is safe to repeat and nothing is deleted but `~/.cache/lstack-herdr`.
// A cockpit source that exists but cannot be read or listed stops the run before any step: no marker, one toast naming
// the file, another try at the next start. A source that reads but is not JSON (queue.json, config.json) only skips
// its step: the rest runs, the marker lists it in `skipped`, and one warning names it. Sources are never changed.
// Files are written through a verified staging copy and installed without replacing anything somebody else wrote
// (install); leftover staging files are removed at the next start.
//   1 to-do      ~/.config/cockpit/todo.md → data/lazuli/todo.md, unless that holds anything but an empty list
//   2 routines   ~/.config/cockpit/routines/*.md → data/lazuli/routines/, existing files kept
//   3 pins       the lazuli apps among config.json `.spaces` → settings.pins, only while settings.json has no `pins`
//                (config.json holds tokens: only the `.spaces` value is kept in memory, and nothing of it is logged)
//   4 queue      ~/.cache/cockpit/queue.json, `app:<address>` queues → data/lazuli/queue.json, unless that holds items
//   5 labels     lstack-herdr.resume → lazuli.resume on every live terminal that has it; terminals on machines whose
//                layout is not ready, or whose relabelling failed, are left for later (`pendingMachines`, "" = this
//                computer). A pending machine stays pending, even while absent from machines(), until its layout is
//                ready and its labels moved. A failed label never holds the other steps or the marker back.
//   6 cache      rm -rf ~/.cache/lstack-herdr, the path checked as an exact string
//   7 marker     {version, at, counts, pendingMachines, skipped}, then one toast with the counts (none when nothing
//                moved)
//
// migrated() starts the run on first call and resolves when it ends (never rejects): sys/todo.js and sys/queue.js
// await it before their first read. The status copy calls start(cx) in init (the run, and the timer that relabels
// terminals of pending machines) and stop() in close.

import * as fs from "fs/promises";
import { appHome, home, checking, exec, hc, machines, terminals, readTextFile, writeTextFile, notify } from "herdr";
import { plan } from "../core/migrate-plan.js";
import { NEW_FILE } from "../core/todo-doc.js";
import { t } from "../core/i18n.js";
import { updateSettings, settingsPath } from "./store.js";

const log = (msg) => console.log(`[lazuli/migrate] ${msg}`);
const errText = (e) => e?.message ?? String(e);
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

const RETRY_MS = 60000;
const RM_TIMEOUT_MS = 60000;
const INSTALL_TIMEOUT_MS = 10000;

function paths() {
  const h = home();
  const a = appHome();
  const data = `${a}/data/lazuli`;
  return {
    home: h,
    appHome: a,
    todo: `${h}/.config/cockpit/todo.md`,
    routines: `${h}/.config/cockpit/routines`,
    config: `${h}/.config/cockpit/config.json`,
    queue: `${h}/.cache/cockpit/queue.json`,
    cache: `${h}/.cache/lstack-herdr`,
    todoTarget: `${data}/todo.md`,
    routinesTarget: `${data}/routines`,
    queueTarget: `${data}/queue.json`,
    marker: `${data}/migrated.json`,
  };
}

const dirname = (path) => path.slice(0, path.lastIndexOf("/")) || "/";
const machineOf = (address) => (address.includes("/") ? address.slice(0, address.indexOf("/")) : null);
// A machine as `pendingMachines` names it: its name, "" for this computer.
const keyOf = (name) => name ?? "";

/** Machine key → its layout state ("loading" | "ready" | "unavailable"); this computer counts as ready when
 *  machines() does not list it. */
function machineStates() {
  const states = new Map(machines().map((m) => [keyOf(m.name), m.layout]));
  if (!states.has("")) states.set("", "ready");
  return states;
}

/** The live terminals on these machines, as plan() takes them (the label commands reach live terminals only). */
function terminalsOn(keys) {
  return terminals()
    .filter((term) => typeof term.address === "string" && term.state === "live" && keys.has(keyOf(machineOf(term.address))))
    .map((term) => ({ address: term.address, labels: isPlain(term.labels) ? term.labels : {} }));
}

/** Whether a target queue.json is exactly an empty queue document, judged before normalize(): an object whose
 *  `queues` is absent or holds only empty lists, and whose `inflight` (sends sys/queue.js has not settled) is absent
 *  or an empty list. Anything else, including entries normalize() would drop, is kept. */
const emptyQueue = (text) => {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isPlain(raw)) return false;
  if (raw.inflight !== undefined && !(Array.isArray(raw.inflight) && raw.inflight.length === 0)) return false;
  if (raw.queues === undefined) return true;
  return isPlain(raw.queues) && Object.values(raw.queues).every((list) => Array.isArray(list) && list.length === 0);
};

/** Whether a target holds something a copy must not replace: an existing file, unless `empty(text)` says it holds
 *  nothing yet. A file that cannot be read counts as holding something. */
async function holds(path, empty) {
  let text;
  try {
    text = await readTextFile(path);
  } catch {
    return true;
  }
  return text !== null && !empty(text);
}

/** The names in one of lazuli's own folders; [] when it cannot be listed (each copy checks its target again). */
async function fileNames(dir) {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter((d) => !d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
}

// cockpit's files are read with fs/promises, which has no size limit (readTextFile stops at 1 MiB). Absent means
// nothing to move. One that exists but cannot be read or listed (an I/O failure, maybe passing) stops the run before
// its first step, so no marker is written and the next start tries again. One that reads but is not JSON stays broken:
// its step is skipped, the rest runs, and the marker lists it in `skipped`. The file itself is left as it is.

/** A source that exists but cannot be used. `source` names it in the toast; the message never carries its content. */
function unreadable(source, path, why) {
  const e = new Error(`${path}: ${why}`);
  e.source = source;
  e.path = path;
  return e;
}

async function present(source, path) {
  try {
    return await fs.exists(path);
  } catch (e) {
    throw unreadable(source, path, errText(e));
  }
}

/** The file's text, or null when it is absent. */
async function sourceText(source, path) {
  if (!(await present(source, path))) return null;
  try {
    return await fs.readFile(path, "utf8");
  } catch (e) {
    throw unreadable(source, path, errText(e));
  }
}

/** The file's JSON value, or null when it is absent or not JSON; the latter is added to `skipped` as
 *  `{file, reason: "not-json"}`. */
async function sourceJson(source, path, skipped) {
  const text = await sourceText(source, path);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    skipped.push({ file: path, reason: "not-json" });
    return null;
  }
}

/** The file names in a source folder, or [] when it is absent. */
async function sourceNames(source, dir) {
  if (!(await present(source, dir))) return [];
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).filter((d) => !d.isDirectory()).map((d) => d.name);
  } catch (e) {
    throw unreadable(source, dir, errText(e));
  }
}

// Only `.spaces` of cockpit's config.json leaves this function; the rest of it (tokens) is dropped at once, and an
// error names the file, never its content.
async function pinSource(path, skipped) {
  const config = await sourceJson("pins", path, skipped);
  return isPlain(config) ? { spaces: config.spaces } : null;
}

/** plan()'s input, and the sources skipped as not JSON. */
async function gather(p, now) {
  const states = machineStates();
  const ready = new Set([...states].filter(([, layout]) => layout === "ready").map(([key]) => key));
  const skipped = [];
  const input = {
    done: false,
    now,
    home: p.home,
    appHome: p.appHome,
    todo: { exists: await present("todo", p.todo), targetExists: await holds(p.todoTarget, (text) => text === NEW_FILE) },
    routines: { names: await sourceNames("routines", p.routines), existing: await fileNames(p.routinesTarget) },
    config: await pinSource(p.config, skipped),
    queue: { doc: await sourceJson("queue", p.queue, skipped), targetExists: await holds(p.queueTarget, emptyQueue) },
    terminals: terminalsOn(ready),
    cacheExists: await fs.exists(p.cache).catch(() => false),
    pendingMachines: [...states].filter(([, layout]) => layout !== "ready").map(([key]) => key).sort(),
  };
  return { input, skipped };
}

// Every file the migration writes is staged first: a `<dest>.part-migrate-<token>` beside it, read back and compared
// with the source, then moved into place. An exit or a full disk midway leaves at most a staging file (removed at the
// next start, sweepParts), never a partial destination that a later run would take as the person's own.
const PART = /\.part-migrate-[a-z0-9]+$/;
const partOf = (dest) => `${dest}.part-migrate-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

function sameBytes(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// What a file holds, read as `data` was given (text for a string, else bytes), and whether it equals `data`.
const readAs = (path, data) => (typeof data === "string" ? fs.readFile(path, "utf8") : fs.readFile(path));
const equal = (got, data) => (typeof data === "string" ? got === data : sameBytes(got, data));

/** Writes `data` to a fresh staging file beside `dest` and checks that it reads back the same. Returns its path. */
async function stage(dest, data) {
  await fs.mkdir(dirname(dest), { recursive: true });
  const tmp = partOf(dest);
  try {
    await fs.writeFile(tmp, data);
    if (!equal(await readAs(tmp, data), data)) throw new Error(`${tmp}: staged copy differs from its source`);
  } catch (e) {
    await fs.unlink(tmp).catch(() => {});
    throw e;
  }
  return tmp;
}

/** Puts `data` at `dest` without ever replacing what somebody else wrote. Absent: the staged, verified copy is
 *  hard-linked in (`ln` refuses when the destination appeared meanwhile), then checked there. Present and
 *  `placeholder(text)` (a file holding nothing yet; `data` must be text): replaced atomically by writeTextFile, only
 *  while it still holds that text. Anything else stays. Resolves "installed", "replaced" or "kept". */
async function install(dest, data, placeholder = () => false) {
  let current;
  try {
    current = await readTextFile(dest);
  } catch {
    return "kept";
  }
  if (current !== null) {
    if (typeof data !== "string" || !placeholder(current)) return "kept";
    try {
      await writeTextFile(dest, data, current);
    } catch (e) {
      const now = await readTextFile(dest).catch(() => undefined);
      if (now !== current) return "kept";
      throw e;
    }
    if ((await fs.readFile(dest, "utf8")) !== data) throw new Error(`${dest}: replaced copy differs from its source`);
    return "replaced";
  }
  const tmp = await stage(dest, data);
  try {
    const r = await exec("ln", [tmp, dest], { timeout: INSTALL_TIMEOUT_MS });
    if (r.code !== 0) {
      if (await fs.exists(dest)) return "kept";
      throw new Error(`ln ${dest}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
    }
  } finally {
    await fs.unlink(tmp).catch((e) => log(`${tmp} not removed: ${errText(e)}`));
  }
  if (!equal(await readAs(dest, data), data)) throw new Error(`${dest}: installed copy differs from its source`);
  return "installed";
}

/** Replaces `dest` (the marker, lazuli's own) with JSON: the staged, verified copy renamed over it. */
async function replaceJson(dest, value) {
  const tmp = await stage(dest, `${JSON.stringify(value, null, 2)}\n`);
  const r = await exec("mv", ["-f", tmp, dest], { timeout: INSTALL_TIMEOUT_MS });
  if (r.code !== 0) {
    await fs.unlink(tmp).catch(() => {});
    throw new Error(`mv ${dest}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  }
}

/** Removes the staging files a run that stopped midway left in lazuli's data folders. */
async function sweepParts(p) {
  for (const dir of [dirname(p.marker), p.routinesTarget]) {
    let names;
    try {
      names = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!PART.test(name)) continue;
      await fs.unlink(`${dir}/${name}`).then(() => log(`removed leftover ${dir}/${name}`), (e) => log(`${dir}/${name} not removed: ${errText(e)}`));
    }
  }
}

async function hcOk(args) {
  const r = await hc(args);
  if (r.code !== 0) throw new Error(`hc ${args[0]} ${args[1]}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
}

function kept(result, path) {
  if (result === "kept") log(`kept ${path}`);
}

async function runStep(step, p) {
  switch (step.op) {
    case "copy": {
      // The to-do list is text (an empty list may be replaced); routines are copied byte for byte.
      if (step.to === p.todoTarget) {
        kept(await install(step.to, await fs.readFile(step.from, "utf8"), (text) => text === NEW_FILE), step.to);
      } else {
        kept(await install(step.to, await fs.readFile(step.from)), step.to);
      }
      return;
    }
    case "write-json":
      kept(await install(step.to, `${JSON.stringify(step.value, null, 2)}\n`, emptyQueue), step.to);
      return;
    case "pins":
      // cockpit's pins are a starting point only: once settings.json has pins (an earlier run, or the person), they stay.
      if (await settingsHavePins()) {
        log("settings.json already has pins; cockpit's are not applied");
        return "kept";
      }
      await updateSettings((draft) => {
        draft.pins = [...step.pins];
      });
      return "applied";
    case "label":
      await hcOk(["label", step.address, `${step.key}=${step.value}`]);
      await hcOk(["label", step.address, `${step.clear}=`]);
      return;
    case "rm": {
      if (step.path !== `${home()}/.cache/lstack-herdr`) throw new Error(`refused to remove ${step.path}`);
      const r = await exec("rm", ["-rf", step.path], { timeout: RM_TIMEOUT_MS });
      if (r.code !== 0) throw new Error(`rm: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
      return;
    }
    case "marker":
      await replaceJson(step.to, step.value);
      return;
    default:
      throw new Error(`unknown step ${step.op}`);
  }
}

/** Whether lazuli's settings.json itself names `pins` (the live settings always have them, as defaults when absent).
 *  A file that cannot be read fails the step; one that is not JSON has none. */
async function settingsHavePins() {
  const text = await readTextFile(settingsPath());
  if (text == null) return false;
  try {
    const value = JSON.parse(text);
    return isPlain(value) && Object.prototype.hasOwnProperty.call(value, "pins");
  } catch {
    return false;
  }
}

async function execute(steps, p) {
  for (const step of steps) {
    try {
      await runStep(step, p);
    } catch (e) {
      e.step = step.op;
      throw e;
    }
  }
}

/** The marker, or null when absent. One that exists but cannot be read or parsed counts as done: a second run would
 *  put cockpit's pins back over the person's. */
async function readMarker(path) {
  let text;
  try {
    text = await readTextFile(path);
  } catch (e) {
    if (!(await fs.exists(path).catch(() => false))) return null;
    log(`migrated.json not read: ${errText(e)}`);
    return { version: 1, at: null, counts: {}, pendingMachines: [] };
  }
  if (text == null) return null;
  let value = null;
  try {
    value = JSON.parse(text);
  } catch {
    log("migrated.json is not JSON; taken as done");
  }
  const m = isPlain(value) ? value : {};
  return {
    ...m,
    counts: isPlain(m.counts) ? m.counts : {},
    pendingMachines: Array.isArray(m.pendingMachines) ? m.pendingMachines.filter((k) => typeof k === "string") : [],
  };
}

function summary(c) {
  const parts = [];
  if (c.todo) parts.push(t("shell.migrate.todo"));
  if (c.routines) parts.push(t("shell.migrate.routines", { count: c.routines }));
  if (c.pins) parts.push(t("shell.migrate.pins", { count: c.pins }));
  if (c.queue) parts.push(t("shell.migrate.queue", { count: c.queue }));
  if (c.labels) parts.push(t("shell.migrate.labels", { count: c.labels }));
  if (c.cache) parts.push(t("shell.migrate.cache"));
  return parts.join(" · ");
}

// Machine keys whose terminals still carry the old label; known once the first run ended.
let pending = [];
let main = null;
let mainDone = false;

async function runMain() {
  const p = paths();
  await sweepParts(p);
  const marker = await readMarker(p.marker);
  if (marker) {
    pending = marker.pendingMachines;
    return;
  }
  let input;
  let skipped;
  try {
    ({ input, skipped } = await gather(p, Date.now()));
  } catch (e) {
    if (!e?.source) throw e;
    log(`${e.source} source not read, nothing moved, no marker written: ${errText(e)}`);
    notify({ title: t("shell.migrate.failed"), body: t("shell.migrate.unreadable", { path: e.path }), level: "error", timeout: 12000 });
    return;
  }
  const planned = plan(input);
  const counts = { ...planned.counts };
  // A terminal whose label cannot move does not hold the rest back: its machine joins `pendingMachines`, which
  // retryPending works through, and the marker is written. Any other failed step writes no marker.
  const failedMachines = new Set();
  try {
    for (const step of planned.steps) {
      let run = step;
      if (step.op === "marker") {
        const pendingMachines = [...new Set([...input.pendingMachines, ...failedMachines])].sort();
        // The marker records what was skipped, so the warning below shows once: the next start finds the marker.
        run = { ...step, value: { ...step.value, counts: { ...counts }, pendingMachines, skipped } };
        pending = pendingMachines;
      }
      try {
        if ((await runStep(run, p)) === "kept" && step.op === "pins") counts.pins = 0;
      } catch (e) {
        if (step.op !== "label") {
          e.step = step.op;
          throw e;
        }
        const key = keyOf(machineOf(step.address));
        log(`${step.address} not relabelled, ${key || "this computer"} stays pending: ${errText(e)}`);
        failedMachines.add(key);
        counts.labels -= 1;
      }
    }
  } catch (e) {
    pending = [];
    log(`step ${e.step ?? "?"} failed, no marker written: ${errText(e)}`);
    notify({ title: t("shell.migrate.failed"), body: t("shell.migrate.retry", { step: e.step ?? "?" }), level: "error", timeout: 12000 });
    return;
  }
  const body = summary(counts);
  if (body) notify({ title: t("shell.migrate.done"), body, level: "success", timeout: 10000 });
  for (const s of skipped) log(`skipped ${s.file}: ${s.reason}`);
  if (skipped.length) {
    notify({
      title: t("shell.migrate.skippedTitle"),
      body: skipped.map((s) => t("shell.migrate.skipped", { path: s.file })).join("\n"),
      level: "warning",
      timeout: 12000,
    });
  }
}

/** Resolves once the migration has run, or at once when it ran before or under `herdr-app check`. Starts it on the
 *  first call. Never rejects. */
export function migrated() {
  if (checking()) return Promise.resolve();
  if (!main) {
    main = runMain()
      .catch((e) => log(`failed: ${errText(e)}`))
      .finally(() => {
        mainDone = true;
      });
  }
  return main;
}

let retrying = false;

// Relabels the terminals of each pending machine whose layout is ready now, and records it in the marker. A machine
// leaves `pending` only once all its labels moved; one that is loading, unavailable or absent from machines() stays.
async function retryPending() {
  if (retrying || !pending.length) return;
  retrying = true;
  try {
    const states = machineStates();
    const p = paths();
    const done = [];
    let labels = 0;
    for (const key of pending.filter((k) => states.get(k) === "ready")) {
      const { steps } = plan({
        done: false, now: Date.now(), home: p.home, appHome: p.appHome,
        todo: { exists: false, targetExists: true }, routines: { names: [], existing: [] }, config: null,
        queue: { doc: null, targetExists: true }, terminals: terminalsOn(new Set([key])), cacheExists: false, pendingMachines: [],
      });
      const relabel = steps.filter((s) => s.op === "label");
      try {
        await execute(relabel, p);
      } catch (e) {
        log(`${key || "this computer"} not relabelled yet: ${errText(e)}`);
        continue;
      }
      done.push(key);
      labels += relabel.length;
    }
    if (!done.length) return;
    const remaining = pending.filter((k) => !done.includes(k));
    const old = (await readMarker(p.marker)) ?? { version: 1, at: Date.now(), counts: {} };
    const total = { ...old.counts, labels: (typeof old.counts.labels === "number" ? old.counts.labels : 0) + labels };
    await replaceJson(p.marker, { ...old, version: 1, at: old.at ?? Date.now(), counts: total, pendingMachines: remaining });
    pending = remaining;
    log(`relabelled ${labels} terminals on ${done.map((k) => k || "this computer").join(", ")}`);
  } catch (e) {
    log(`pending machines not relabelled yet: ${errText(e)}`);
  } finally {
    retrying = false;
  }
}

let task = null;

/** Runs the migration (if it has not run) and relabels terminals on pending machines as they become ready. Call it
 *  from the status copy's init; it replaces a running one. */
export function start(cx) {
  stop();
  if (checking()) return;
  migrated();
  const own = cx.timer.every(RETRY_MS, (cx) => {
    if (mainDone && !pending.length && !retrying) {
      own.cancel();
      if (task === own) task = null;
      return;
    }
    cx.spawn(async () => {
      await migrated();
      await retryPending();
    });
  });
  task = own;
}

/** Stops relabelling pending machines. A run in progress finishes. */
export function stop() {
  task?.cancel();
  task = null;
}
