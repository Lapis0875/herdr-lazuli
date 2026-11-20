// The herdr-caffeinate chip in the status bar (DESIGN D3; herdr-caffeinate CONTRACTS C3, C9): what the shared state
// `herdr-caffeinate.state` looks like as a chip, and which of that mod's commands the palette offers. lazuli imports
// nothing from herdr-caffeinate; this reads the published object only. Pure: the caller passes `now` and the time it
// opened the host window; the views map the returned codes to catalog keys (`shell.caffeinate.*`).

/** The mod's folder name, its command prefix and its shared key. */
export const MOD = "herdr-caffeinate";
export const STATE_KEY = `${MOD}.state`;

/** The hidden host window lazuli opens on every services start (C9): it keeps herdr-caffeinate's engine running and
 *  receives `herdr-app do herdr-caffeinate.<command>`. No `keep`: lazuli reopens it itself; the same key replaces an
 *  open one. */
export const HOST = Object.freeze({
  mod: MOD,
  props: Object.freeze({ view: "host" }),
  kind: "window",
  frame: "none",
  key: `${MOD}.host`,
  width: 2,
  height: 2,
  at: Object.freeze({ x: 0, y: 0 }),
});

/** Chip statuses → the lazuli icon (`ui/icons/<icon>.svg`) and tone (`ui/kit.js` toneColor). Only the accent ones are
 *  active styling: the Mac is being kept awake. */
export const STATUS = Object.freeze({
  /** No usable state yet: missing, not version 1, or published before lazuli opened the host. */
  starting: Object.freeze({ icon: "coffee", tone: "unknown" }),
  off: Object.freeze({ icon: "coffee", tone: "tertiary" }),
  /** Agent mode with no agent working: sleep is allowed until one works. */
  waiting: Object.freeze({ icon: "coffee", tone: "secondary" }),
  on: Object.freeze({ icon: "coffee", tone: "accent" }),
  agent: Object.freeze({ icon: "coffee", tone: "accent" }),
  timer: Object.freeze({ icon: "coffee", tone: "accent" }),
  /** A session the power adapter started (C10 AC trigger). */
  trigger: Object.freeze({ icon: "coffee", tone: "accent" }),
});

/** The closed-lid mark beside the chip, by `closedLid.status`; `off` draws none. `engaged` and `external` both mean
 *  closing the lid will not sleep the Mac (ours, or another tool's `disablesleep 1`). */
export const LID = Object.freeze({
  engaged: Object.freeze({ icon: "lock", tone: "accent" }),
  external: Object.freeze({ icon: "lock", tone: "secondary" }),
  blocked: Object.freeze({ icon: "triangle-alert", tone: "warning" }),
  unavailable: Object.freeze({ icon: "triangle-alert", tone: "warning" }),
});

/** Why closed-lid is blocked (C3 `closedLid.blocked`); anything else reads as `unknown`. */
export const BLOCKED = Object.freeze(["ac", "battery", "thermal", "unknown", "other-instance"]);

/** The C1 commands the palette offers, in order. `timer:cancel` only while a timer runs; `install` / `uninstall` only
 *  once the state says what is installed. Minutes are D1's presets. */
export const COMMANDS = Object.freeze([
  "menu",
  "toggle",
  "mode:on",
  "mode:agent",
  "mode:off",
  "timer:15",
  "timer:60",
  "timer:120",
  "timer:cancel",
  "display:toggle",
  "closed-lid:toggle",
  "install",
  "uninstall",
]);

const MODES = new Set(["off", "on", "agent", "timer"]);
const MINUTE = 60000;
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const num = (v) => typeof v === "number" && Number.isFinite(v);

/** Whether a published state is version 1 with the fields the chip reads, and not older than `openedAt` (the host
 *  open; null skips that check). */
export function usable(state, openedAt = null) {
  if (!isObj(state) || state.v !== 1) return false;
  if (!num(state.at) || !MODES.has(state.mode) || typeof state.active !== "boolean") return false;
  return !num(openedAt) || state.at >= openedAt;
}

/** Whole minutes left until `endsAt`, rounded up and at least 1, as `{h, m}`; null without a usable `endsAt`. */
export function timeLeft(endsAt, now) {
  if (!num(endsAt) || !num(now)) return null;
  const minutes = Math.max(1, Math.ceil((endsAt - now) / MINUTE));
  return { h: Math.floor(minutes / 60), m: minutes % 60 };
}

function statusOf(s) {
  if (s.active) {
    if (s.reason === "trigger") return "trigger";
    if (s.mode === "timer" || s.reason === "timer") return "timer";
    if (s.mode === "agent" || s.reason === "agent") return "agent";
    return "on";
  }
  return s.mode === "agent" ? "waiting" : "off";
}

function lidOf(s) {
  const lid = isObj(s.closedLid) ? s.closedLid : null;
  const status = lid && Object.prototype.hasOwnProperty.call(LID, lid.status) ? lid.status : null;
  if (!status) return null;
  const blocked = status === "blocked" ? (BLOCKED.includes(lid.blocked) ? lid.blocked : "unknown") : null;
  return { status, ...LID[status], blocked };
}

/**
 * The chip for a published state: `{status, icon, tone, active, display, left, lid, install}`.
 * - `active`: true only for the accent statuses; a state that is not usable (see `usable`) is `starting`, never active,
 *   with no lid mark and `install: null`.
 * - `left`: `{h, m}` for a timer (see `timeLeft`), else null. `display`: the display is kept on while awake.
 * - `lid`: `{status, icon, tone, blocked}` or null; `blocked` is a BLOCKED code for status `blocked`, else null.
 * - `install`: `{sudo, failsafe}` booleans, or null when the state does not say.
 */
export function chip(state, { openedAt = null, now = null } = {}) {
  if (!usable(state, openedAt)) return { status: "starting", ...STATUS.starting, active: false, display: false, left: null, lid: null, install: null };
  const status = statusOf(state);
  const install = isObj(state.install) && typeof state.install.sudo === "boolean" && typeof state.install.failsafe === "boolean" ? { sudo: state.install.sudo, failsafe: state.install.failsafe } : null;
  return {
    status,
    ...STATUS[status],
    active: STATUS[status].tone === "accent",
    display: state.display === true && state.active,
    left: status === "timer" ? timeLeft(state.endsAt, now) : null,
    lid: lidOf(state),
    install,
  };
}

/** The palette's commands for a chip (from `chip`), in COMMANDS order. */
export function paletteCommands(c) {
  const known = isObj(c) && c.status !== "starting" && isObj(c.install);
  const installed = known && c.install.sudo && c.install.failsafe;
  const some = known && (c.install.sudo || c.install.failsafe);
  return COMMANDS.filter((cmd) => {
    if (cmd === "timer:cancel") return isObj(c) && c.status === "timer";
    if (cmd === "install") return known && !installed;
    if (cmd === "uninstall") return known && some;
    return true;
  });
}

/** The catalog key suffix of a command: `mode:on` → `mode.on` (`shell.caffeinate.cmd.<suffix>`). */
export function commandKey(cmd) {
  return String(cmd).replace(/:/g, ".");
}
