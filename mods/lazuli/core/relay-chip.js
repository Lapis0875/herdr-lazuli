// The herdr-relay chip in the status bar (CONTRACTS "herdr-relay chip"; ARCHITECTURE §8.1): what the relay's files and
// its herdr-core terminal say, as a chip, and the programs lazuli runs to turn it on and off. lazuli imports nothing from
// herdr-relay or its mirror mod; this reads what they write (herdr-relay docs/INSTALL.md §9). Pure: the service
// (sys/relay.js) hands in what it read and the time; the views map the codes to catalog keys (`shell.relay.*`).
//
// Status sources, in order:
// - `hc get herdr-relay --json` `state` `live`: the bridge Herdr started (`autostart run`) is up → on.
// - Otherwise `~/.herdr/herdr-relay/mirror-endpoint.json` `{port, pid}` with a live pid that accepts a connection on its
//   port: a bridge started outside Herdr (a terminal, the launchd agent) → external, shown only, never stopped.
// - Otherwise off when a launcher is known (a valid `autostart.json`, or the one lazuli remembered when it turned the
//   relay off), else not set up.

/** The herdr-core terminal `autostart run` starts the bridge in (`hc get|kill herdr-relay`). */
export const TERMINAL = "herdr-relay";
/** herdr-relay's state folder, under the home folder. */
export const STATE_DIR = ".herdr/herdr-relay";
/** `herdr-relay autostart on` writes it; its presence turns autostart on. */
export const AUTOSTART_FILE = "autostart.json";
/** The running bridge's `{v, port, pid}`; may be stale after a crash. */
export const ENDPOINT_FILE = "mirror-endpoint.json";
/** The launcher lazuli remembers before it turns autostart off, under `data/lazuli/`. */
export const REMEMBER_FILE = "relay.json";
/** The bridge's log under the home folder (`autostart run` appends to it). */
export const LOG_FILE = "Library/Logs/herdr-relay.log";
/** The end of every accepted launcher: herdr-relay's launcher shim. */
export const LAUNCHER_SUFFIX = "/packages/bridge/bin/herdr-relay";
/** The longest accepted PATH, in UTF-16 code units (the mirror mod's limit). */
export const PATH_MAX = 8192;

/** `hc`'s arguments: read the bridge's terminal; stop it. */
export const GET_ARGS = Object.freeze(["get", TERMINAL, "--json"]);
export const KILL_ARGS = Object.freeze(["kill", TERMINAL]);

/** The verbs of `lazuli.relay:<verb>`. */
export const VERBS = Object.freeze(["on", "off", "status"]);

/** Chip statuses → the lazuli icon (`ui/icons/<icon>.svg`) and tone (`ui/kit.js` toneColor). `starting` and
 *  `stopping` draw a spinner in their tone instead of the icon. */
export const STATUS = Object.freeze({
  /** The bridge Herdr started is up. */
  on: Object.freeze({ icon: "tablet-smartphone", tone: "accent" }),
  off: Object.freeze({ icon: "tablet-smartphone", tone: "tertiary" }),
  starting: Object.freeze({ icon: "loader", tone: "secondary" }),
  stopping: Object.freeze({ icon: "loader", tone: "secondary" }),
  /** A bridge started outside Herdr answers: shown, never stopped. */
  external: Object.freeze({ icon: "tablet-smartphone", tone: "secondary" }),
  /** No autostart.json and no remembered launcher. */
  unset: Object.freeze({ icon: "tablet-smartphone", tone: "tertiary" }),
  /** The last action failed (until the status it left changes). */
  error: Object.freeze({ icon: "triangle-alert", tone: "error" }),
  /** `hc get` failed for another reason than "no such terminal". */
  unknown: Object.freeze({ icon: "tablet-smartphone", tone: "unknown" }),
});

/** The statuses whose chip has words (`shell.relay.label.<status>`); the others show the icon only. */
export const LABELED = Object.freeze(["on", "starting", "stopping", "external", "error"]);

/** Why an action failed: the program exited non-zero (`detail`: its last line), could not start (`detail`: the
 *  error), the status did not reach the goal in time, or the launcher could not be saved before `autostart off`. */
export const ERRORS = Object.freeze(["exit", "spawn", "timeout", "remember"]);

// What each settled status offers: the Herdr-run bridge can be stopped, a known launcher can start it; nothing else.
const ACTIONS = Object.freeze({ on: ["off"], off: ["on"], external: [], unset: [], unknown: [] });
const DETAIL_MAX = 200;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" && v ? v : null);
const posInt = (v) => Number.isInteger(v) && v > 0;
/** A C0 control character or DEL. */
const CONTROL = /[\x00-\x1f\x7f]/;

function parseJson(text) {
  if (typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const clip = (s) => (s.length > DETAIL_MAX ? `${s.slice(0, DETAIL_MAX - 1)}…` : s);

/** A `{launcher, path}` the mirror mod would run, or null: an absolute launcher ending in LAUNCHER_SUFFIX and a PATH of
 *  1 to PATH_MAX characters, neither with a control character. */
export function launcherConfig(v) {
  if (!isObj(v)) return null;
  const { launcher, path } = v;
  if (typeof launcher !== "string" || !launcher.startsWith("/") || !launcher.endsWith(LAUNCHER_SUFFIX) || CONTROL.test(launcher)) return null;
  if (typeof path !== "string" || path.length < 1 || path.length > PATH_MAX || CONTROL.test(path)) return null;
  return { launcher, path };
}

/** `autostart.json`'s text (null: no file) → `{kind: "absent"}`, `{kind: "ok", config}` (version 1 with a usable
 *  launcher and PATH, as the mirror mod accepts it) or `{kind: "invalid"}`. */
export function autostartState(text) {
  if (text === null || text === undefined) return { kind: "absent" };
  const file = parseJson(text);
  const config = isObj(file) && file.v === 1 ? launcherConfig(file) : null;
  return config ? { kind: "ok", config } : { kind: "invalid" };
}

/** The remembered launcher (`data/lazuli/relay.json`) → `{launcher, path}` or null. */
export function rememberedConfig(text) {
  const file = parseJson(text);
  return isObj(file) && file.v === 1 ? launcherConfig(file) : null;
}

/** The text of `data/lazuli/relay.json` for a launcher, saved at `at` (ms). */
export function rememberText(config, at) {
  return `${JSON.stringify({ v: 1, launcher: config.launcher, path: config.path, at })}\n`;
}

/** `mirror-endpoint.json`'s text → `{port, pid}`, or null. */
export function endpointOf(text) {
  const file = parseJson(text);
  if (!isObj(file)) return null;
  const { port, pid } = file;
  return posInt(port) && port < 65536 && posInt(pid) ? { port, pid } : null;
}

/** `/bin/ps -p <pid> -o pid=`'s result → whether that pid is running. */
export function pidAlive(result, pid) {
  return isObj(result) && result.code === 0 && String(result.stdout ?? "").trim() === String(pid);
}

/** The reason a program gave: its last non-empty stderr line, else stdout's, else `exit <code>`; `hc`'s JSON errors
 *  give their message. At most 200 characters. */
export function reasonOf(result) {
  if (!isObj(result)) return "";
  const last = (text) => String(text ?? "").split("\n").map((s) => s.trim()).filter(Boolean).at(-1) ?? "";
  let line = last(result.stderr) || last(result.stdout) || (Number.isInteger(result.code) ? `exit ${result.code}` : "");
  const json = parseJson(line);
  if (isObj(json) && isObj(json.error) && str(json.error.message)) line = json.error.message;
  return clip(line);
}

/**
 * `hc get herdr-relay --json` → `{kind: "live", address}` (the terminal runs), `{kind: "none", state}` (no such
 * terminal, `state` null, or a finished one) or `{kind: "unknown", reason}` (hc failed otherwise, or printed no
 * state). `result` is the ExecResult, or `{error: message}` when hc could not run.
 */
export function terminalState(result) {
  if (!isObj(result)) return { kind: "unknown", reason: "no answer from hc" };
  if (str(result.error)) return { kind: "unknown", reason: clip(result.error) };
  if (result.code === 0) {
    const t = parseJson(result.stdout);
    if (!isObj(t) || !str(t.state)) return { kind: "unknown", reason: "hc get printed no state" };
    return t.state === "live" ? { kind: "live", address: str(t.address) } : { kind: "none", state: t.state };
  }
  const err = parseJson(String(result.stderr ?? "").trim()) ?? parseJson(String(result.stdout ?? "").trim());
  if (isObj(err) && isObj(err.error) && err.error.kind === "not_found") return { kind: "none", state: null };
  return { kind: "unknown", reason: reasonOf(result) || "hc get failed" };
}

/**
 * What the service read (`obs`) → the settled status: `on`, `external`, `unknown`, `off` or `unset`; null when there is
 * nothing to show (`present` false: no state folder and nothing remembered). `obs`: `{present, terminal (terminalState),
 * autostart (autostartState), answering (the endpoint's pid runs and its port accepts), remembered (config or null)}`.
 */
export function baseOf(obs) {
  if (!isObj(obs) || obs.present !== true) return null;
  const kind = obs.terminal?.kind;
  if (kind === "live") return "on";
  if (kind !== "none") return "unknown";
  if (obs.answering === true) return "external";
  return obs.autostart?.kind === "ok" || launcherConfig(obs.remembered) ? "off" : "unset";
}

function errorOf(error, base) {
  if (!isObj(error) || (error.action !== "on" && error.action !== "off") || !ERRORS.includes(error.code)) return null;
  if (error.base !== base) return null;
  return { action: error.action, code: error.code, detail: str(error.detail), seconds: Number.isFinite(error.seconds) ? error.seconds : null };
}

/**
 * The chip, or null (nothing to show, or `device`: a herdr-relay device, where lazuli shows and does nothing about the
 * relay): `{status, base, icon, tone, busy, actions, error, autostart, address, reason}`.
 * - `busy` ("starting" | "stopping", an action in flight) wins and offers nothing.
 * - `error` (`{action, code, detail, seconds, base}`, the last failed action) shows while the settled status is still
 *   the one it left (`base`); a change (the mirror mod started the bridge, say) drops it.
 * - `actions`: "off" for on, "on" for off, none otherwise; an error offers what its settled status offers.
 * - `autostart`: autostart.json is valid. `address`: the live terminal's. `reason`: why the status is unknown.
 */
export function chip(obs, { busy = null, error = null, device = false } = {}) {
  if (device) return null;
  const base = baseOf(obs);
  if (!base) return null;
  const common = {
    base,
    autostart: obs.autostart?.kind === "ok",
    address: base === "on" ? (obs.terminal.address ?? null) : null,
    reason: base === "unknown" ? (str(obs.terminal?.reason) ?? null) : null,
  };
  if (busy === "starting" || busy === "stopping") return { status: busy, ...STATUS[busy], busy: true, actions: [], error: null, ...common };
  const err = errorOf(error, base);
  const status = err ? "error" : base;
  return { status, ...STATUS[status], busy: false, actions: [...ACTIONS[base]], error: err, ...common };
}

/** The actions a chip offers (the palette's and the menu's), [] without one. */
export function paletteCommands(c) {
  return isObj(c) && Array.isArray(c.actions) ? [...c.actions] : [];
}

/** Whether `lazuli.relay:<verb>` may act now: `status` always (with a chip), `on` / `off` only when offered. */
export function allowed(c, verb) {
  if (!isObj(c)) return false;
  return verb === "status" || paletteCommands(c).includes(verb);
}

/** The launcher `on` uses: autostart.json's when valid, else the remembered one; null when neither. */
export function onPlan(obs) {
  if (obs?.autostart?.kind === "ok") return obs.autostart.config;
  return launcherConfig(obs?.remembered);
}

/**
 * What `off` does before `hc kill herdr-relay`: `remember` the launcher of a valid autostart.json (saved before it is
 * removed), and run `autostart off` with `autostartOff` when the file exists (its own launcher, else the remembered
 * one; null: none known, or no file).
 */
export function offPlan(autostart, remembered) {
  if (autostart?.kind === "ok") return { remember: autostart.config, autostartOff: autostart.config };
  if (autostart?.kind === "invalid") return { remember: null, autostartOff: launcherConfig(remembered) };
  return { remember: null, autostartOff: null };
}

/** `/usr/bin/env`'s arguments for `herdr-relay autostart <verb>` with a launcher and the PATH it recorded (as the mirror
 *  mod runs it): `autostart on` then records that same PATH. */
export function launcherArgs(config, verb) {
  return [`PATH=${config.path}`, "/bin/sh", config.launcher, "autostart", verb];
}

/** Whether a fresh read shows an action done: `on` → the terminal is live and the bridge answers; `off` → no live
 *  terminal. */
export function settled(verb, obs) {
  const kind = obs?.terminal?.kind;
  if (verb === "on") return kind === "live" && obs.answering === true;
  if (verb === "off") return kind === "none";
  return false;
}

/** Catalog keys: the chip's words (null: none), its tooltip's first part, and an error's reason. */
export function labelKey(c) {
  return isObj(c) && LABELED.includes(c.status) ? `shell.relay.label.${c.status}` : null;
}
export function tipKey(c) {
  if (!isObj(c)) return null;
  return c.status === "error" ? `shell.relay.tip.error.${c.error.action}` : `shell.relay.tip.${c.status}`;
}
export function whyKey(error) {
  if (!isObj(error)) return null;
  return error.code === "timeout" ? `shell.relay.why.timeout.${error.action}` : `shell.relay.why.${error.code}`;
}
