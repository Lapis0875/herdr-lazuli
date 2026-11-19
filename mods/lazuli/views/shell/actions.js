// What the shell views do beyond drawing: the overlays they open (palette, settings, menus, recap), agent actions
// (focus, fork, snooze, pin, queue), the external editor, the sidebar fold, and `perform(action)` for the plain-data
// action descriptors menu items carry across the overlay boundary:
//   {kind: "run", run, args?}             a Herdr or lazuli command
//   {kind: "overlay", spec}               openOverlay(spec) (the worktree dialog, Herdr's add machine)
//   {kind: "open", url}                   the default browser
//   {kind: "go", address}                 an agent's terminal, in the work view
//   {kind: "fork", address, place}        a new session branched from the agent's ("tab" | "right")
//   {kind: "snooze", address, until}      until ms, or null to wake
//   {kind: "pin", address, pinned}        Herdr's agent pin
//   {kind: "queue", address}              the prompt queue dialog for that agent
//   {kind: "recap", address?}             the recap dialog
//   {kind: "settings"}                    lazuli's settings
//   {kind: "editor", path, on?, folder?}  the external editor on a file (or a folder, `folder: true`)
//   {kind: "show", child}                 a center view
//   {kind: "peek", terminal}              Herdr's peek over the tab
//   {kind: "unpin-app", app}              takes a pinned app out of the sidebar

import { agents, closeOverlay, exec, hc, notify, openOverlay, run, setShared, shared, terminals, window as appWindow } from "herdr";
import { MOD } from "../../sys/state.js";
import { layoutNode, showCenter } from "../../sys/bus.js";
import * as store from "../../sys/store.js";
import * as fleet from "../../sys/fleet.js";
import * as queue from "../../sys/queue.js";
import { LABEL, decodeRecord } from "../../core/resume-tools.js";
import { forkArgv } from "../../core/agent-cmd.js";
import { t } from "../../core/i18n.js";
import { openRecap as openRecapTab } from "../recap.js";

const log = (msg) => console.log(`[lazuli/shell] ${msg}`);
const errText = (e) => e?.message ?? String(e);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" && v ? v : null);

// ---------------------------------------------------------------------------------------------------------------------
// Overlays.

/** The palette dialog's size (ARCHITECTURE §2: a dialog over the window). */
export const PALETTE = Object.freeze({ width: 640, height: 480 });
/** The settings dialog's size. */
export const SETTINGS = Object.freeze({ width: 620, height: 640 });

// The open palette's overlay id (module state, shared by every copy, F3): ⇧⌘P again closes it.
let paletteId = null;

/** The palette copy says it is open (its init) or gone (its close). */
export function paletteOpened(id) {
  paletteId = str(id);
}
export function paletteClosed(id) {
  if (!id || id === paletteId) paletteId = null;
}

/** ⇧⌘P: opens the palette, or closes the open one. */
export function togglePalette() {
  if (paletteId) {
    const id = paletteId;
    paletteId = null;
    closeOverlay(id);
    return null;
  }
  paletteId = openOverlay({ mod: MOD, props: { view: "palette" }, kind: "dialog", ...PALETTE });
  return paletteId;
}

/** lazuli's settings as a dialog (sidebar footer, palette). */
export function openSettings() {
  return openOverlay({ mod: MOD, props: { view: "settings" }, kind: "dialog", ...SETTINGS });
}

/** The recap dialog (⌘R, views/recap.js), on the tab of the agent's stage when `address` is given. */
export function openRecap(address) {
  const stage = str(address) ? fleet.rows().find((a) => a.address === address)?.stage : null;
  return openRecapTab(stage ?? undefined);
}

const MENU_ROW = 28;
const MENU_LABEL = 24;
const MENU_RULE = 9;

/** The height a menu of these items needs (views/menu.js draws them with ui/kit.js Menu). */
export function menuHeight(items) {
  let h = 4 * 2 + 2;
  for (const item of items) h += item?.separator ? MENU_RULE : item?.heading ? MENU_LABEL : MENU_ROW;
  return h + Math.max(0, items.length - 1);
}

/**
 * A context menu at the pointer. `items`: `[{label, icon?, detail?, kbd?, danger?, disabled?, checked?, action}]`,
 * `{separator: true}` or `{heading}`; each `action` is a descriptor perform() runs. Plain data only: they travel as
 * the overlay's props.
 */
export function openMenu(items, { width = 240, label } = {}) {
  const list = (Array.isArray(items) ? items : []).filter(Boolean);
  if (!list.length) return null;
  return openOverlay({
    mod: MOD,
    kind: "popup",
    frame: "none",
    width,
    height: menuHeight(list),
    props: { view: "menu", items: list, width, ...(label ? { label } : {}) },
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The sidebar's fold, as Herdr's own chrome does it (H/mods/workspace-chrome/main.js): the same shared keys, so a
// fold made here and one made in Herdr's layout agree.

/** The sidebar's width now, in px. */
export function sidebarWidth() {
  const px = layoutNode("sidebar")?.size?.px;
  return typeof px === "number" ? px : 268;
}

/** The sidebar draws its compact rail below 160 px (H/AGENTS.md Layouts). */
export const sidebarNarrow = () => sidebarWidth() < 160;

/** Folds the sidebar to its rail (76 px on macOS, room for the traffic lights), or back to its width. */
export function toggleSidebar() {
  const narrow = sidebarNarrow();
  if (!narrow) setShared("sidebar.width", sidebarWidth());
  setShared("sidebar.collapsed", !narrow);
  const back = shared("sidebar.width");
  run("layout.resize", { id: "sidebar", px: narrow ? (typeof back === "number" && back >= 160 ? back : 268) : appWindow()?.platform === "macos" ? 76 : 44 });
}

// ---------------------------------------------------------------------------------------------------------------------
// Agents.

/** The resume record Herdr's terminal carries (sys/resume.js writes it): `{tool, session, argv, cwd}` or null. */
export function sessionOf(address) {
  const term = (terminals() ?? []).find((x) => x.address === address);
  return term ? decodeRecord(term.labels?.[LABEL]) : null;
}

/** Whether an agent's session can be forked: its tool and session are known. */
export function canFork(address) {
  const rec = sessionOf(address);
  return Boolean(rec && forkArgv(rec.tool, rec.argv, rec.session));
}

/** Starts a new session branched from the agent's (core/agent-cmd.js forkArgv): in a new tab of its space, in its
 *  folder (`place: "tab"`), or split to the right of its pane (`"right"`). False with a toast when it cannot. */
export function forkAgent(address, place = "tab") {
  const rec = sessionOf(address);
  const argv = rec ? forkArgv(rec.tool, rec.argv, rec.session) : null;
  if (!argv) {
    notify({ title: t("shell.fork.none"), body: t("shell.fork.noneBody"), level: "warning", timeout: 6000 });
    return false;
  }
  const a = (agents() ?? []).find((x) => x.address === address);
  try {
    if (place === "right" && a?.pane) run("pane.split", { direction: "right", pane: a.pane, argv });
    else run("tab.new", { ...(a?.space ? { space: a.space } : {}), ...(rec.cwd ? { folder: rec.cwd } : {}), argv, focus: true });
    if (layoutNode("center")?.active !== "work") showCenter("work");
    return true;
  } catch (e) {
    notify({ title: t("shell.fork.failed"), body: errText(e), level: "error" });
    return false;
  }
}

/** The snooze choices for an agent, as absolute times from now: an hour, this evening (18:00, when still ahead),
 *  tomorrow morning (09:00). */
export function snoozeTimes(now = Date.now()) {
  const at = (days, hour) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d.getTime();
  };
  const evening = at(0, 18);
  return { hour: now + 3600000, evening: evening > now + 600000 ? evening : null, morning: at(1, 9) };
}

// ---------------------------------------------------------------------------------------------------------------------
// The external editor: settings().editor (a command such as `code`, `cursor`, `zed`), VS Code by default; a remote
// path opens over SSH in the VS Code family (`vscode-remote` file or folder URIs).

const APPS = { code: "Visual Studio Code", cursor: "Cursor", zed: "Zed", windsurf: "Windsurf", subl: "Sublime Text" };
/** Editors of the VS Code family: they open `vscode-remote://ssh-remote+<host><path>` URIs (Remote - SSH). */
const REMOTE_EDITORS = new Set(["code", "code-insiders", "cursor", "windsurf", "codium", "vscodium"]);

/** The editor command from the settings. */
export function editorCommand() {
  const e = store.settings().editor;
  return typeof e === "string" && e.trim() ? e.trim() : "code";
}

/** The editor's name for labels: "VS Code", "Cursor", …. */
export function editorName() {
  const name = editorCommand();
  return name === "code" ? "VS Code" : (APPS[name] ?? name);
}

async function hostOf(machine) {
  try {
    const r = await hc(["machine", "ls", "--json"]);
    const parsed = JSON.parse(r.stdout);
    const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.machines) ? parsed.machines : [];
    const m = list.find((x) => x?.name === machine);
    return String(m?.target ?? m?.host ?? m?.ssh ?? machine).replace(/^ssh:\/\//, "");
  } catch {
    return machine;
  }
}

/** Runs one command; true when it started and exited 0. A command that cannot start (not installed) rejects in
 *  exec: that counts as false, logged, so the caller can try another way. */
async function launched(cmd, args) {
  try {
    return (await exec(cmd, args)).code === 0;
  } catch (e) {
    log(`${cmd} did not start: ${errText(e)}`);
    return false;
  }
}

/** Opens a file (or, with `folder: true`, a folder) in the external editor; a toast says why when it could not.
 *  A path on another machine (`on`) opens over SSH, `--file-uri` or `--folder-uri`, in the editors of the VS Code
 *  family only; any other editor is refused with the toast. */
export async function openInEditor(path, on = null, { folder = false } = {}) {
  const name = editorCommand();
  if (!str(path)) return false;
  let ok;
  let body = t("shell.editor.failedBody");
  if (on) {
    if (REMOTE_EDITORS.has(name.split("/").pop())) {
      // Each path segment encoded: `#`, `?`, `%` or a space would otherwise cut or change the path in the URI.
      const uriPath = path.split("/").map(encodeURIComponent).join("/");
      ok = await launched(name, [folder ? "--folder-uri" : "--file-uri", `vscode-remote://ssh-remote+${await hostOf(on)}${uriPath}`]);
    } else {
      ok = false;
      body = t("shell.editor.remoteBody", { editor: editorName(), machine: on });
    }
  } else {
    ok = await launched(name, [path]);
    // An editor whose command is not on the PATH (exec rejects, or it exits nonzero) still opens by its app name
    // on macOS.
    if (!ok && appWindow()?.platform === "macos") ok = await launched("open", ["-a", APPS[name] ?? name, path]);
  }
  if (!ok) notify({ title: t("shell.editor.failed", { editor: editorName() }), body, level: "error", timeout: 8000 });
  return ok;
}

// ---------------------------------------------------------------------------------------------------------------------
// Descriptors.

/** Runs one action descriptor (see the header). Resolves when an asynchronous one is done. */
export async function perform(action) {
  if (!isObj(action)) return;
  switch (action.kind) {
    case "run":
      if (str(action.run)) run(action.run, isObj(action.args) ? action.args : {});
      return;
    case "overlay":
      if (isObj(action.spec)) openOverlay(action.spec);
      return;
    case "open":
      if (str(action.url)) await exec("open", [action.url]);
      return;
    case "go":
      if (str(action.address)) fleet.goTo(action.address);
      return;
    case "fork":
      if (str(action.address)) forkAgent(action.address, action.place === "right" ? "right" : "tab");
      return;
    case "snooze":
      if (str(action.address)) fleet.setSnooze(action.address, typeof action.until === "number" ? action.until : null);
      return;
    case "pin":
      if (str(action.address)) run("terminal.pin", { terminal: action.address, pinned: action.pinned === true });
      return;
    case "queue":
      queue.open(str(action.address));
      return;
    case "recap":
      openRecap(action.address);
      return;
    case "settings":
      openSettings();
      return;
    case "editor":
      await openInEditor(action.path, str(action.on), { folder: action.folder === true });
      return;
    case "show":
      if (str(action.child)) showCenter(action.child);
      return;
    case "peek":
      if (str(action.terminal)) run("terminal.peek", { terminal: action.terminal });
      return;
    case "unpin-app":
      if (str(action.app)) await store.updateSettings((s) => ({ ...s, pins: s.pins.filter((p) => p !== action.app) }));
      return;
    default:
      log(`unknown action ${JSON.stringify(action.kind)}`);
  }
}

/** perform() with its failure logged, for click handlers. */
export function act(action) {
  perform(action).then(undefined, (e) => log(`${action?.kind} failed: ${errText(e)}`));
}
