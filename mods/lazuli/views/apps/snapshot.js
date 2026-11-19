// The board on a herdr-relay device (DESIGN D4, ARCHITECTURE §8): whether this window is one (a refusal by herdr-relay
// says so, never an empty fleet), and the Mac's saved fleet read from its snapshot file instead of the live store (the
// device's own fleet service publishes its empty list there). Module scope is shared by every copy (F3): the host
// check runs once per window and the saved rows serve all copies.

import { exec } from "herdr";
import * as fs from "fs/promises";
import * as fleet from "../../sys/fleet.js";
import * as gh from "../../sys/gh.js";
import * as store from "../../sys/store.js";
import { STORE } from "../../sys/state.js";

const errText = (e) => e?.message ?? String(e);

const SAVED_MS = 15000;
// `okAt`: when the rows were read; `problem`: why the last read failed (the rows then are the earlier ones).
const saved = { rows: [], at: null, okAt: null, problem: null, readAt: 0, reading: false };
// What this window's host is: `unknown` until the probe answers, then `local` (it runs commands) or `relay`.
const host = { state: "unknown", asking: false, triedAt: 0 };
const RETRY_MS = 10000;
/** herdr-relay's refusal of a command it does not allow (core/gh-map.js `ghError`). */
const refused = (r) => r?.code === 126 && String(r.stderr ?? "").trimStart().startsWith("herdr-relay:");

/** Asks the host whether it runs commands at all: herdr-relay refuses every program no profile row enables (F12),
 *  `true` among them. Asked until it answers (a probe that could not start is asked again after 10 s); only the
 *  layout's own copies ask (a preview runs nothing). Redraws the asking copy once known. */
export function probeHost(cx) {
  if (host.state !== "unknown" || host.asking || Date.now() - host.triedAt < RETRY_MS) return;
  host.asking = true;
  host.triedAt = Date.now();
  cx.spawn(async (cx) => {
    try {
      host.state = refused(await exec("true", [], { timeout: 5000 })) ? "relay" : "local";
    } catch {
      // Not known yet: nothing acts until a later probe says `local`.
    }
    host.asking = false;
    try {
      cx.notify();
    } catch {
      // The view that asked closed meanwhile.
    }
  });
}

/** Whether this window shows the Mac's saved picture: herdr-relay refused the host probe or a `gh` call. */
export function snapshotMode() {
  if (host.state === "relay") return true;
  const s = gh.state();
  return s.blocked === "relay" || gh.data()?.error?.kind === "relay";
}

/** Whether this window may act (fetch details, run actions, take keys): only once the host answered `local`, never
 *  while unknown, never on a relay device. */
export const hostLocal = () => host.state === "local" && !snapshotMode();

/** Reads the Mac's fleet snapshot: `{rows, at}`, or `{problem}` (`missing`: none saved yet; `unreadable` with the
 *  read's `error`; `damaged`: not a fleet snapshot). Through fs/promises, which has no 1 MiB cap (readTextFile has),
 *  as sys/store.js reads snapshots: a large fleet still loads. */
async function readSaved() {
  const path = store.snapPath(STORE.fleet);
  let text;
  try {
    text = (await fs.exists(path)) ? await fs.readFile(path, "utf8") : null;
  } catch (e) {
    return { problem: { kind: "unreadable", error: errText(e) } };
  }
  if (text == null) return { problem: { kind: "missing" } };
  let snap = null;
  try {
    snap = JSON.parse(text);
  } catch {
    snap = null;
  }
  const value = snap?.value;
  if (!value || typeof value !== "object" || !Array.isArray(value.agents)) return { problem: { kind: "damaged" } };
  return { rows: value.agents, at: typeof value.at === "number" ? value.at : typeof snap.at === "number" ? snap.at : null };
}

/** Reads the Mac's saved fleet (data/lazuli/snap/fleet.json) again when older than 15 s; redraws the asking copy. A
 *  snapshot that cannot be read keeps the rows read last, marked stale with the problem; a valid one with no agents
 *  is an empty fleet. */
export function refreshSaved(cx) {
  if (saved.reading || Date.now() - saved.readAt < SAVED_MS) return;
  saved.reading = true;
  cx.spawn(async (cx) => {
    const r = await readSaved();
    if (r.problem) saved.problem = r.problem;
    else {
      saved.rows = r.rows;
      saved.at = r.at;
      saved.okAt = Date.now();
      saved.problem = null;
    }
    saved.reading = false;
    saved.readAt = Date.now();
    try {
      cx.notify();
    } catch {
      // The view that asked closed meanwhile.
    }
  });
}

/** The agents to draw: live (`fleet.rows`), or the Mac's saved ones in snapshot mode with `at` (when the Mac saved
 *  them), `problem` (the last read failed: `missing` | `unreadable` | `damaged`) and `readAt` (when the rows shown were
 *  read, null before any). Safe in render. */
export function boardRows(now = Date.now()) {
  if (!snapshotMode()) return { rows: fleet.rows(now), snapshot: false, at: null, problem: null, readAt: null };
  return { rows: saved.rows, snapshot: true, at: saved.at, problem: saved.problem, readAt: saved.okAt };
}
