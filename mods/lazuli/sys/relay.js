// herdr-relay in lazuli's status bar (CONTRACTS "herdr-relay chip"; ARCHITECTURE §8.1): whether the bridge that mirrors
// Herdr to the owner's iPad and phone runs, and turning it on and off. lazuli imports nothing from herdr-relay; it runs
// the commands herdr-relay documents (docs/INSTALL.md §9) and reads its state folder.
//
// The status copy's services start it. It does nothing under `herdr-app check`, and nothing on a window not known to be
// the Mac (views/apps/snapshot.js `hostLocal()`: a herdr-relay device refuses exec and hc; there is no chip there and no
// verb acts). On the Mac a 2 s timer reads the status (core/relay-chip.js) at most every 10 s while the window is
// visible, and every second while an action is confirmed:
//   hc get herdr-relay --json; ~/.herdr/herdr-relay/{autostart.json,mirror-endpoint.json}; when no Herdr-run bridge is
//   live and the endpoint file names one: /bin/ps -p <pid> -o pid=, then a TCP connect to 127.0.0.1:<port> (closed at
//   once; no request, so no token is read and nothing is logged by the bridge).
//
// Actions (`lazuli.relay:on|off`, from the chip's menu, the palette or `herdr-app do`), one at a time, decided on a fresh
// read and confirmed by reading again, never by exit codes alone:
//   off: save autostart.json's {launcher, path} to data/lazuli/relay.json, then
//        /usr/bin/env PATH=<path> /bin/sh <launcher> autostart off   (the mirror mod would otherwise restart the bridge)
//        hc kill herdr-relay                                           (exit 3 "was removed" is normal: --rm)
//        until no live terminal, at most 15 s
//   on:  /usr/bin/env PATH=<path> /bin/sh <launcher> autostart on    (records that same PATH again)
//        /usr/bin/env PATH=<path> /bin/sh <launcher> autostart run   (starts `start --lease` in terminal herdr-relay)
//        until the terminal is live and the bridge answers, at most 30 s
// A bridge started outside Herdr is never stopped: lazuli does not signal processes by pid.

import * as fs from "fs/promises";
import net from "net";
import { checking, exec, hc, home, readTextFile, writeTextFile, window as appWindow } from "herdr";
import { dataDir, debugLog } from "./store.js";
import { hostLocal, probeHost } from "../views/apps/snapshot.js";
import {
  STATE_DIR,
  AUTOSTART_FILE,
  ENDPOINT_FILE,
  REMEMBER_FILE,
  LOG_FILE,
  GET_ARGS,
  KILL_ARGS,
  autostartState,
  rememberedConfig,
  rememberText,
  endpointOf,
  pidAlive,
  reasonOf,
  terminalState,
  baseOf,
  chip,
  paletteCommands,
  allowed,
  onPlan,
  offPlan,
  launcherArgs,
  settled,
} from "../core/relay-chip.js";

const TICK_MS = 2000;
const POLL_MS = 10000;
const STEP_MS = 1000;
const CONFIRM_MS = Object.freeze({ on: 30000, off: 15000 });
/** `autostart on|off|run`: the launcher may first fetch the modules deno.lock pins. */
const LAUNCHER_TIMEOUT_MS = 60000;
const PS_TIMEOUT_MS = 5000;
const CONNECT_MS = 2000;
const TIMEOUT = Symbol("timeout");

const errText = (e) => e?.message ?? String(e);
const log = (msg) => {
  console.log(`[lazuli/relay] ${msg}`);
  debugLog("relay", msg);
};

const stateDir = () => `${home()}/${STATE_DIR}`;
const rememberPath = () => `${dataDir()}/${REMEMBER_FILE}`;
/** The bridge's log (`autostart run` appends to it); the chip's menu opens it after a failure. */
export const logPath = () => `${home()}/${LOG_FILE}`;

function redraw(cx) {
  try {
    cx.notify();
  } catch {
    // The status copy closed meanwhile.
  }
}

async function readText(path) {
  try {
    return await readTextFile(path);
  } catch {
    return null;
  }
}

// The running service; null while stopped. obs: the last status read (core baseOf's input); readAt: when; reading: a
// timer read is in flight; seq/applied: reads started/applied, so an older read never replaces a newer one; acting: an
// action runs; busy: "starting" | "stopping" while it changes the relay; error: the last failed action; remembered: the
// launcher in data/lazuli/relay.json (undefined until read); base: the settled status last logged.
let svc = null;

/** Starts the status reads (the status copy's init). Replaces a running service. */
export function start(cx) {
  stop();
  if (checking()) return;
  const s = { obs: null, readAt: 0, reading: false, seq: 0, applied: 0, acting: false, busy: null, error: null, remembered: undefined, base: null, stops: [] };
  svc = s;
  const timer = cx.timer.every(TICK_MS, (tcx) => tick(tcx, s));
  s.stops.push(() => timer.cancel());
  tick(cx, s);
}

/** Stops the reads (the status copy's close). An action in flight finishes; its result is dropped. */
export function stop() {
  const s = svc;
  if (!s) return;
  svc = null;
  for (const fn of s.stops) {
    try {
      fn();
    } catch (e) {
      log(`stop: ${errText(e)}`);
    }
  }
}

/** Cheap checks every tick; a status read only on the Mac, while the window shows, at most every POLL_MS. */
function tick(cx, s) {
  if (svc !== s) return;
  if (!hostLocal()) {
    probeHost(cx);
    return;
  }
  if (s.reading || s.acting || appWindow()?.visible === false || Date.now() - s.readAt < POLL_MS) return;
  s.reading = true;
  cx.spawn(async (tcx) => {
    try {
      await read(tcx, s);
    } catch (e) {
      log(`status read failed: ${errText(e)}`);
    } finally {
      s.reading = false;
      s.readAt = Date.now();
    }
    redraw(tcx);
  });
}

async function loadRemembered(s) {
  if (s.remembered === undefined) s.remembered = rememberedConfig(await readText(rememberPath()));
  return s.remembered;
}

/** Saves the launcher before `autostart off` removes autostart.json; throws when it could not. */
async function saveRemembered(s, config) {
  const path = rememberPath();
  await writeTextFile(path, rememberText(config, Date.now()), await readTextFile(path));
  s.remembered = config;
}

/** Whether the endpoint's pid runs and its port accepts a connection within CONNECT_MS. */
async function answers(cx, { port, pid }) {
  let alive = false;
  try {
    alive = pidAlive(await exec("/bin/ps", ["-p", String(pid), "-o", "pid="], { timeout: PS_TIMEOUT_MS }), pid);
  } catch {
    // ps could not run: not known to answer.
  }
  if (!alive) return false;
  const conn = net.connect("127.0.0.1", port).then(
    (sock) => sock,
    () => null,
  );
  const first = await Promise.race([conn, cx.sleep(CONNECT_MS).then(() => TIMEOUT)]);
  if (first === TIMEOUT) {
    conn.then((sock) => sock?.close());
    return false;
  }
  first?.close();
  return first !== null;
}

/** One status read (core baseOf's input). `port`: also check that a live Herdr-run bridge answers (confirming `on`). */
async function observe(cx, s, port) {
  const dir = stateDir();
  const remembered = await loadRemembered(s);
  const present = (await fs.exists(dir).catch(() => false)) === true;
  if (!present && !remembered) return { present: false };
  const [autoText, endText, got] = await Promise.all([
    readText(`${dir}/${AUTOSTART_FILE}`),
    readText(`${dir}/${ENDPOINT_FILE}`),
    hc([...GET_ARGS]).catch((e) => ({ error: errText(e) })),
  ]);
  const terminal = terminalState(got);
  const endpoint = endpointOf(endText);
  const check = endpoint && (terminal.kind === "none" || (port && terminal.kind === "live"));
  const answering = check ? await answers(cx, endpoint) : false;
  return { present: true, terminal, autostart: autostartState(autoText), endpoint, answering, remembered };
}

function describe(obs) {
  const base = baseOf(obs);
  if (!base) return "absent (no ~/.herdr/herdr-relay)";
  const t = obs.terminal;
  const where = t.kind === "live" ? `terminal ${t.address ?? "?"}` : t.kind === "unknown" ? `hc: ${t.reason}` : "no live terminal";
  const ep = obs.endpoint ? `endpoint port ${obs.endpoint.port} pid ${obs.endpoint.pid}${obs.answering ? " answering" : ""}` : "no endpoint";
  return `${base} (${where}; autostart ${obs.autostart.kind}; ${ep}; launcher ${obs.remembered ? "remembered" : "not remembered"})`;
}

/** Reads the status and keeps it unless a newer read already landed. Logs a change of the settled status. */
async function read(cx, s, { port = false } = {}) {
  const seq = ++s.seq;
  const obs = await observe(cx, s, port);
  if (svc === s && seq > s.applied) {
    s.applied = seq;
    s.obs = obs;
    s.readAt = Date.now();
    const base = baseOf(obs);
    if (base !== s.base) {
      if (s.base !== null || base !== null) log(`status: ${describe(obs)}`);
      s.base = base;
    }
  }
  return obs;
}

/** Reads until the action shows done (null) or its time is up (the failure). */
async function confirm(cx, s, verb) {
  const until = Date.now() + CONFIRM_MS[verb];
  for (;;) {
    const obs = await read(cx, s, { port: verb === "on" });
    if (settled(verb, obs) || svc !== s) return null;
    if (Date.now() >= until) return { code: "timeout", detail: null, seconds: CONFIRM_MS[verb] / 1000 };
    await cx.sleep(STEP_MS);
  }
}

async function launcher(config, verb) {
  const r = await exec("/usr/bin/env", launcherArgs(config, verb), { timeout: LAUNCHER_TIMEOUT_MS });
  log(`autostart ${verb}: exit ${r.code}`);
  return r.code === 0 ? null : { code: "exit", detail: reasonOf(r) };
}

async function turnOn(cx, s) {
  const config = onPlan(s.obs);
  return (await launcher(config, "on")) ?? (await launcher(config, "run")) ?? (await confirm(cx, s, "on"));
}

async function turnOff(cx, s) {
  const plan = offPlan(autostartState(await readText(`${stateDir()}/${AUTOSTART_FILE}`)), await loadRemembered(s));
  if (plan.remember) {
    try {
      await saveRemembered(s, plan.remember);
    } catch (e) {
      return { code: "remember", detail: errText(e) };
    }
  }
  if (plan.autostartOff) {
    const failed = await launcher(plan.autostartOff, "off");
    if (failed) return failed;
  }
  // Not judged: --rm removes the terminal as the bridge exits, often before hc answers (exit 3 "… was removed").
  const killed = await hc([...KILL_ARGS]).catch((e) => ({ code: null, stderr: errText(e) }));
  log(`hc kill ${KILL_ARGS[1]}: exit ${killed.code}${killed.code ? ` (${reasonOf(killed)})` : ""}`);
  return confirm(cx, s, "off");
}

/** The chip to draw (core `chip`), or null: no service, nothing to show, or not known to be the Mac. Safe in render. */
export function view() {
  const s = svc;
  if (!s) return null;
  return chip(s.obs, { busy: s.busy, error: s.error, device: !hostLocal() });
}

/** The actions the palette offers ("on" / "off"), [] without a chip. */
export function commands() {
  return paletteCommands(view());
}

/**
 * `lazuli.relay:<verb>` (sys/bus.js; the status copy's command loop hands its cx). `status` reads now and logs the
 * result; `on` / `off` act when the chip offers them after a fresh read, one at a time, and keep a failure (with the
 * settled status it left) for the chip. Nothing under `herdr-app check` or off the Mac.
 */
export function command(cx, verb) {
  const s = svc;
  if (!s || checking()) return;
  if (!hostLocal()) {
    log(`relay:${verb} refused: this window is not known to be the Mac`);
    return;
  }
  if (verb === "status") {
    cx.spawn(async (tcx) => {
      try {
        log(`status: ${describe(await read(tcx, s, { port: true }))}`);
      } catch (e) {
        log(`status read failed: ${errText(e)}`);
      }
      redraw(tcx);
    });
    return;
  }
  if (verb !== "on" && verb !== "off") {
    log(`unknown command relay:${verb}`);
    return;
  }
  if (s.acting) {
    log(`relay:${verb} ignored: ${s.busy ?? "an action"} in progress`);
    return;
  }
  s.acting = true;
  cx.spawn(async (tcx) => {
    try {
      await read(tcx, s);
      const c = chip(s.obs, { error: s.error });
      if (!allowed(c, verb)) {
        log(`relay:${verb} not offered while ${c?.status ?? "absent"}`);
        return;
      }
      s.busy = verb === "on" ? "starting" : "stopping";
      s.error = null;
      redraw(tcx);
      let failure;
      try {
        failure = verb === "on" ? await turnOn(tcx, s) : await turnOff(tcx, s);
      } catch (e) {
        failure = { code: "spawn", detail: errText(e) };
      }
      s.busy = null;
      if (failure) {
        await read(tcx, s).catch(() => null);
        s.error = { action: verb, ...failure, base: baseOf(s.obs) };
        log(`turning ${verb} failed (${failure.code}${failure.detail ? `: ${failure.detail}` : ""}); ${describe(s.obs)}`);
      } else log(`turned ${verb}`);
    } catch (e) {
      log(`relay:${verb} failed: ${errText(e)}`);
    } finally {
      s.busy = null;
      s.acting = false;
      redraw(tcx);
    }
  });
}
