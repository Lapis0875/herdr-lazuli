// Names and shapes every lazuli module agrees on: shared keys, store names, the layout nodes the
// keys act on, the key-command table and the settings schema (ARCHITECTURE §2, §3, D2).
// No herdr imports, so Node tests can load it.

export const MOD = "lazuli";

/** Shared keys (`shared()` / `setShared()`), all under `lazuli.`. */
export const KEY = Object.freeze({
  /** `{[storeName]: counter}`: bumped after a store change; setting it re-renders every copy. */
  rev: "lazuli.rev",
  /** The live settings object (normalized), so a change applies at once (C3). */
  settings: "lazuli.settings",
  /** File-tab registry by fid: `{file, on, preview, mode, space, tab, pane, at}` (§6), persisted. */
  tabs: "lazuli.tabs",
  /** `{address: untilMs}`. */
  snooze: "lazuli.snooze",
  /** Attention already looked at. */
  seen: "lazuli.seen",
  /** `{state: "absent"|"building"|"ready"|"failed", bin, reason}`. */
  pdfd: "lazuli.pdfd",
  /** The resolved UI language, "ko" or "en": derived from the setting, kept for a warm start. */
  language: "lazuli.language",
  /** The Assistant screen's remembered UI (D25): `{v:1, folder, selected:{agent, profile, session}|null,
   *  collapsed:[profile]}`. A value for another folder is reset; a selected row that no longer exists is cleared. */
  assistantUi: "lazuli.assistant.ui",
  /** The Hermes local sessions the Assistant made (`local-<64 hex>` ids), so only those are listed and restored:
   *  `{v:1, sessions:[{profile, folder, session, at}]}`, newest first, at most 200 (core/assistant-list.js). */
  assistantOwned: "lazuli.assistant.owned",
});

/** Store names that have a rev counter and a snapshot file (`data/lazuli/snap/<name>.json`). */
export const STORE = Object.freeze({
  gh: "gh",
  fleet: "fleet",
  todo: "todo",
  routines: "routines",
  queue: "queue",
  scan: "scan",
  restore: "restore",
});

/** A valid store name: also its snapshot file name. */
export const STORE_NAME = /^[a-z][a-z0-9-]*$/;

/** Layout node ids the commands act on (§3). */
export const NODE = Object.freeze({ center: "center", view: "view", panel: "panel", panelBody: "panel-body" });

/** Children of the `center` stack. */
export const CENTER = Object.freeze(["home", "work", "inbox", "todo", "routines", "assistant"]);

/** Children of the `panel-body` stack; the keys use the same names. */
export const PANELS = Object.freeze(["review", "files", "changes", "tree"]);

/** Which copy handles a command, since every shown copy receives it (F2). */
export const OWNER = Object.freeze({
  /** The `status` copy: always shown, once per layout. */
  status: "status",
  /** The `file` copy whose tab is the focused tab. */
  file: "file",
  /** Every copy that receives it. */
  self: "self",
});

/** keys.json commands (the action without `lazuli.`) and their owner (D2). */
export const COMMANDS = Object.freeze({
  palette: OWNER.status,
  home: OWNER.status,
  "go:inbox": OWNER.status,
  "go:todo": OWNER.status,
  "go:routines": OWNER.status,
  "go:assistant": OWNER.status,
  "agent-view": OWNER.status,
  panel: OWNER.status,
  "panel:review": OWNER.status,
  "panel:files": OWNER.status,
  "panel:changes": OWNER.status,
  "panel:tree": OWNER.status,
  "file-mode": OWNER.file,
  quickopen: OWNER.status,
  "next-waiting": OWNER.status,
  "next:blocked": OWNER.status,
  "next:done": OWNER.status,
  queue: OWNER.status,
  resume: OWNER.status,
  recap: OWNER.status,
  pr: OWNER.status,
  ticket: OWNER.status,
});

/** Commands that carry an argument after the prefix: `target:<target>` (notification clicks, §7),
 *  `key:<keystroke>` (test hook, §2), `assistant:<verb>` (the Assistant screen's verbs, to every copy) and
 *  `relay:<verb>` (herdr-relay on, off, status: the status chip's menu, the palette, `herdr-app do`; sys/relay.js). */
export const PREFIXED = Object.freeze({ "target:": OWNER.status, "key:": OWNER.self, "assistant:": OWNER.self, "relay:": OWNER.status });

/** What Herdr itself sends a focusable copy (`pane.go` onto it, a popup over it closed). */
export const FOCUS = "focus";

/** Every full action string keys.json binds. */
export const ACTIONS = Object.freeze(Object.keys(COMMANDS).map((c) => `${MOD}.${c}`));

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

/** A command as nextCommand() delivers it (no `lazuli.` prefix) → `{name, arg, owner}`, or null when
 *  it is not in the table. Prefixed commands are named without the colon: `target`, `key`, `assistant`. */
export function parseCommand(command) {
  if (typeof command !== "string") return null;
  if (own(COMMANDS, command)) return { name: command, arg: null, owner: COMMANDS[command] };
  if (command === FOCUS) return { name: FOCUS, arg: null, owner: OWNER.self };
  for (const prefix of Object.keys(PREFIXED)) {
    if (command.startsWith(prefix) && command.length > prefix.length) {
      return { name: prefix.slice(0, -1), arg: command.slice(prefix.length), owner: PREFIXED[prefix] };
    }
  }
  return null;
}

/** Whether a keys.json action string (`lazuli.<command>`) is one lazuli handles. */
export function isAction(action) {
  if (typeof action !== "string" || !action.startsWith(`${MOD}.`)) return false;
  const command = action.slice(MOD.length + 1);
  return command !== FOCUS && parseCommand(command) !== null;
}

// Settings (`data/lazuli/settings.json`).

export const SETTINGS_VERSION = 2;
export const LANGUAGE_SETTINGS = Object.freeze(["system", "ko", "en"]);
/** B9 zoom steps: fit width, then percent. */
export const PDF_ZOOMS = Object.freeze(["fit", 50, 75, 100, 125, 150, 200]);
/** The pinnable apps, in their default order. A version 1 file gains `assistant` once (see normalizeSettings). */
export const DEFAULT_PINS = Object.freeze(["inbox", "todo", "routines", "assistant"]);

/** A fresh copy of the settings used when the file is absent. */
export function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    language: "system",
    agent: { command: ["omp"] },
    notifications: { system: true },
    gh: { org: [], pollSec: 120 },
    routines: { maxParallel: 3 },
    pins: [...DEFAULT_PINS],
    pdf: { zoom: "fit" },
    editor: "code",
    assistant: { folder: null, debugAgent: null },
  };
}

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const plain = (v) => (isPlain(v) ? JSON.parse(JSON.stringify(v)) : {});
const strings = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === "string" && s.trim() !== "") : []);
/** `assistant.debugAgent`: a non-empty array of non-empty strings as it is, else null (one element of another kind
 *  makes the whole argv unusable, so it is not trimmed down to the rest). */
const argvOrNull = (v) => (Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s.trim() !== "") ? [...v] : null);
const positive = (v) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const positiveInt = (v) => (Number.isInteger(v) && v > 0 ? v : null);

/** v1 → v2: a file's own pins gain the Assistant once (pins it does not name read as the defaults, which hold it).
 *  A v2 file keeps the person's pins as they are. */
const gainsAssistantPin = (r) => Array.isArray(r.pins) && !(typeof r.version === "number" && r.version >= 2) && !strings(r.pins).includes("assistant");

/** `assistant.folder`: an absolute path without trailing slashes, or null. */
function assistantFolder(v) {
  const p = typeof v === "string" ? v.trim() : "";
  return p.startsWith("/") ? p.replace(/(.)\/+$/, "$1") : null;
}

/** Any parsed settings value → a complete settings object. Known fields fall back to their default when
 *  missing or invalid; unknown fields are kept as they are. Never throws for JSON input. */
export function normalizeSettings(raw) {
  const r = plain(raw);
  const d = defaultSettings();
  const agent = plain(r.agent);
  const command = strings(agent.command);
  const model = typeof agent.model === "string" ? agent.model.trim() : "";
  delete agent.model;
  const notifications = plain(r.notifications);
  const gh = plain(r.gh);
  const routines = plain(r.routines);
  const pdf = plain(r.pdf);
  const assistant = plain(r.assistant);
  return {
    ...r,
    version: SETTINGS_VERSION,
    language: LANGUAGE_SETTINGS.includes(r.language) ? r.language : d.language,
    agent: { ...agent, command: command.length ? command : d.agent.command, ...(model ? { model } : {}) },
    notifications: { ...notifications, system: typeof notifications.system === "boolean" ? notifications.system : d.notifications.system },
    gh: { ...gh, org: [...new Set(strings(gh.org).map((s) => s.trim()))], pollSec: positive(gh.pollSec) ?? d.gh.pollSec },
    routines: { ...routines, maxParallel: positiveInt(routines.maxParallel) ?? d.routines.maxParallel },
    pins: Array.isArray(r.pins) ? [...new Set(strings(r.pins)), ...(gainsAssistantPin(r) ? ["assistant"] : [])] : d.pins,
    pdf: { ...pdf, zoom: PDF_ZOOMS.includes(pdf.zoom) ? pdf.zoom : d.pdf.zoom },
    editor: typeof r.editor === "string" && r.editor.trim() !== "" ? r.editor.trim() : d.editor,
    assistant: { ...assistant, folder: assistantFolder(assistant.folder), debugAgent: argvOrNull(assistant.debugAgent) },
  };
}

/** A parsed settings file → the settings to write back to it once, or null. Only a file older than
 *  SETTINGS_VERSION whose migration changes what it holds is written (v1 → v2: `assistant` appended to its
 *  pins); a missing field reads as its default without a write. */
export function migratedSettings(raw) {
  return isPlain(raw) && gainsAssistantPin(raw) ? normalizeSettings(raw) : null;
}
