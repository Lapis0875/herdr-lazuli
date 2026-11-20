// herdr-caffeinate in lazuli (DESIGN D3; herdr-caffeinate CONTRACTS C9, D11). lazuli imports nothing from that mod:
// on every services start (the `status` copy's init: Herdr start, a switch back to lazuli, a reload) it looks for
// `<app home>/mods/herdr-caffeinate/mod.json`. Present: it opens herdr-caffeinate's hidden host window (core HOST),
// which keeps that mod's engine running and takes `herdr-app do herdr-caffeinate.<command>`; the status bar then draws
// the chip from shared("herdr-caffeinate.state") and the palette lists its commands. Absent: nothing at all (no chip,
// no host, no palette entries, no log lines).
//
// A timer runs the chip's minutes down: while one runs, the window redraws when the shown minute changes.

import * as fs from "fs/promises";
import { appHome, checking, openOverlay, shared } from "herdr";
import { MOD, STATE_KEY, HOST, chip, paletteCommands } from "../core/caffeinate-chip.js";
import { debugLog } from "./store.js";

const TICK_MS = 15000;

const errText = (e) => e?.message ?? String(e);
// Only reached once the mod was found, so an absent mod never writes a line.
const log = (msg) => {
  console.log(`[lazuli/caffeinate] ${msg}`);
  debugLog("caffeinate", msg);
};

// The running service; null while stopped. present: the mod was found and its host opened; openedAt: when (a state
// published before it is stale); shown: the timer minutes the ticker last redrew for.
let svc = null;

/** Looks for the mod and opens its host (the status copy's init). Replaces a running service. */
export function start(cx) {
  stop();
  if (checking()) return;
  const s = { present: false, openedAt: null, shown: null, stops: [] };
  svc = s;
  cx.spawn(async (cx) => {
    const there = await fs.exists(`${appHome()}/mods/${MOD}/mod.json`).catch(() => false);
    if (svc !== s || there !== true) return;
    s.openedAt = Date.now();
    try {
      const id = openOverlay({ ...HOST, props: { ...HOST.props }, at: { ...HOST.at } });
      debugLog("caffeinate", `host opened (${id})`);
    } catch (e) {
      log(`host did not open: ${errText(e)}`);
    }
    s.present = true;
    const ticker = cx.timer.every(TICK_MS, (cx) => {
      const left = view(Date.now())?.left;
      const shown = left ? left.h * 60 + left.m : null;
      if (shown === s.shown) return;
      s.shown = shown;
      cx.notify();
    });
    s.stops.push(() => ticker.cancel());
    cx.notify();
  });
}

/** Stops the timer (the status copy's close). The host window stays: a layout switch closes it, and the next start
 *  replaces it. */
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

/** Whether herdr-caffeinate was found at the last services start. */
export function present() {
  return svc?.present === true;
}

/** The chip to draw (core `chip`), or null when the mod is absent. Safe in render. */
export function view(now) {
  const s = svc;
  return s?.present ? chip(shared(STATE_KEY), { openedAt: s.openedAt, now }) : null;
}

/** The commands the palette offers (core `paletteCommands`), or [] when the mod is absent. */
export function commands(now) {
  const c = view(now);
  return c ? paletteCommands(c) : [];
}
