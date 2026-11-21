// The services the layout's `status` copy runs (ARCHITECTURE §2): it is always shown and exists once per layout, so
// it starts every background service in init and stops the ones that can stop in close. Each service guards itself
// against `herdr-app check`; a `preview: true` copy never calls this (views/status.js).
//
// Order: the migration first (the to-do and queue services wait for it before their first read), then the data
// services, then what acts on them (notifications), then the file tabs and the PDF sidecar, then herdr-caffeinate's
// host when that mod is installed (sys/caffeinate.js; absent, it does nothing).

import { handle } from "../../sys/bus.js";
import * as migrate from "../../sys/migrate.js";
import * as gh from "../../sys/gh.js";
import * as fleet from "../../sys/fleet.js";
import * as todo from "../../sys/todo.js";
import * as queue from "../../sys/queue.js";
import * as scan from "../../sys/scan.js";
import * as routines from "../../sys/routines.js";
import * as resume from "../../sys/resume.js";
import * as notify from "../../sys/notify.js";
import { startFileTabs } from "../../sys/filetabs.js";
import { startSidecars, stopSidecars } from "../../sys/sidecars.js";
import * as caffeinate from "../../sys/caffeinate.js";
import { togglePalette } from "./actions.js";

const log = (msg) => console.log(`[lazuli/status] ${msg}`);
const errText = (e) => e?.message ?? String(e);

let running = null;
// The last stop's pending work (fleet.stop writes the ledger's last stretches), kept referenced and logged when a
// restart does not wait for it.
let stopping = null;

function step(name, fn) {
  try {
    return fn();
  } catch (e) {
    log(`${name} did not start: ${errText(e)}`);
    return null;
  }
}

/** Starts every service and the `palette` command (the status copy's init). Safe to call again: a running set is
 *  stopped first, without waiting for what its stop still writes (that finishes on its own, failures logged). */
export function startServices(cx) {
  stopServices();
  const s = { stops: [] };
  running = s;
  s.stops.push(handle("palette", () => togglePalette()));
  step("migrate", () => migrate.start(cx));
  step("gh", () => gh.start(cx));
  step("fleet", () => fleet.start(cx));
  step("todo", () => todo.start(cx));
  step("queue", () => queue.start(cx));
  step("scan", () => scan.start(cx));
  step("routines", () => routines.start(cx));
  step("resume", () => resume.start(cx));
  step("notify", () => notify.start(cx));
  const sweep = step("filetabs", () => startFileTabs(cx));
  if (sweep) s.stops.push(() => sweep.cancel());
  step("sidecars", () => startSidecars(cx));
  step("caffeinate", () => caffeinate.start(cx));
  s.stops.push(
    () => caffeinate.stop(),
    () => stopSidecars(),
    () => notify.stop(),
    () => resume.stop(),
    () => routines.stopService(),
    () => scan.stop(),
    () => queue.stop(),
    () => todo.stop(),
    () => fleet.stop(),
    () => gh.stop(),
    () => migrate.stop(),
  );
}

/** Stops every service (the status copy's close), so the next status copy (after a layout switch back) can start
 *  them again with its own cx. Detached work (routine runs, the PDF daemon, builds) keeps going. Every stop runs at
 *  once; the returned promise settles when the ones that return a promise (fleet.stop: the ledger's last write) have
 *  settled. close() awaits it, so the write gets Herdr's close budget (250 ms, H/AGENTS.md) before it is cut off;
 *  a failure is logged, never thrown. */
export function stopServices() {
  const s = running;
  if (!s) return stopping ?? Promise.resolve();
  running = null;
  const pending = [];
  for (const fn of s.stops) {
    try {
      const r = fn();
      if (r && typeof r.then === "function") pending.push(Promise.resolve(r).catch((e) => log(`stop failed: ${errText(e)}`)));
    } catch (e) {
      log(`stop failed: ${errText(e)}`);
    }
  }
  const done = Promise.all(pending).then(() => {
    if (stopping === done) stopping = null;
  });
  stopping = done;
  return done;
}
