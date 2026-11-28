// The command table: every key command reaches every shown copy (F2), and dispatch() lets only its
// owner act (ARCHITECTURE §2): window-wide commands run in the `status` copy, `file-mode` in the
// `file` copy of the focused tab, `key:`, `assistant:` and `focus` in the copy that got them.
//
// A command runs, in this order: a built-in route below (layout moves with Herdr's own commands);
// else the handler a later slice registered with handle(name, fn); else the owner view's
// `command(command, cx)`; else nothing, with a debug line.

import { run, layout, focused, shared } from "herdr";
import { KEY, NODE, CENTER, PANELS, OWNER, parseCommand } from "./state.js";

const log = (msg) => console.log(`[lazuli/bus] ${msg}`);
const errText = (e) => e?.message ?? String(e);

// The shown layout. layout() carries live `active` and `hidden` values (mods/tabs/main.js:66 in the
// app home reads them the same way).

/** The node with that id in a layout tree (children and floating blocks), or null. */
export function findNode(tree, id) {
  if (!tree || typeof tree !== "object") return null;
  if (tree.id === id) return tree;
  for (const child of [...(tree.children ?? []), ...(tree.floating ?? [])]) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

/** The shown layout's node with that id, or null. */
export const layoutNode = (id) => findNode(layout(), id);

/** The active child of a stack in the shown layout, or null. */
export const activeChild = (stack) => layoutNode(stack)?.active ?? null;

/** Shows a child of the center stack: `home`, `work`, `inbox`, `todo`, `routines` or `assistant`. */
export function showCenter(child) {
  run("layout.select", { stack: NODE.center, child });
}

const showWork = () => {
  if (activeChild(NODE.center) !== "work") showCenter("work");
};

/** Home, or back to the work view when Home shows (⌥⌘0). */
export function toggleHome() {
  showCenter(activeChild(NODE.center) === "home" ? "work" : "home");
}

/** The work view: the active tab's panes ↔ the focused agent (⌥⌘A). Shows the work view. */
export function toggleAgentView() {
  run("layout.select", { stack: NODE.view, child: activeChild(NODE.view) === "agent" ? "main" : "agent" });
  showWork();
}

/** Whether the person sees the side panel: shown, and the work view in the center. */
export function panelVisible() {
  const panel = layoutNode(NODE.panel);
  return Boolean(panel) && !panel.hidden && activeChild(NODE.center) === "work";
}

/**
 * Hides a shown node that lives inside the center stack (the side panel, Home's agent card) and leaves the center on
 * the view it showed. `layout.hide` on such a node moved the center stack to its next child (live run 3, D2: closing
 * the call-tree panel with ⌘4 showed the Inbox), while `layout.toggle` keeps it (⌥⌘B), so this toggles a node that
 * is shown, then puts the center back if anything still moved it. Returns whether the node was shown.
 */
export function hideInCenter(id) {
  const node = layoutNode(id);
  if (!node || node.hidden) return false;
  const center = activeChild(NODE.center);
  run("layout.toggle", { id });
  if (center && activeChild(NODE.center) !== center) showCenter(center);
  return true;
}

/** The side panel shown or hidden (⌥⌘B, `layout.toggle`). Showing it shows the work view. */
export function togglePanel() {
  if (panelVisible()) {
    hideInCenter(NODE.panel);
    return;
  }
  if (layoutNode(NODE.panel)?.hidden) run("layout.toggle", { id: NODE.panel });
  showWork();
}

/** The side panel on that child (`review`, `files`, `changes`, `tree`), and the work view. */
export function openPanel(child) {
  run("layout.select", { stack: NODE.panelBody, child });
  run("layout.show", { id: NODE.panel });
  showWork();
}

/** ⌘1–4: opens the panel on that child; pressing the shown child's key hides the panel, the center staying put. */
export function togglePanelChild(child) {
  if (panelVisible() && activeChild(NODE.panelBody) === child) hideInCenter(NODE.panel);
  else openPanel(child);
}

/** A key event as on_key_down gets it, from a keystroke spelled as in keys.json ("cmd-shift-p"). */
export function keyEvent(keystroke) {
  let key;
  let parts;
  if (keystroke.endsWith("-")) {
    key = "-";
    parts = keystroke.slice(0, -1).split("-").filter(Boolean);
  } else {
    parts = keystroke.split("-");
    key = parts.pop() ?? "";
  }
  const held = new Set(parts);
  const modifiers = { shift: held.has("shift"), control: held.has("ctrl"), alt: held.has("alt"), platform: held.has("cmd"), function: held.has("fn") };
  const event = { key, keystroke, modifiers };
  if (!modifiers.control && !modifiers.platform) {
    if (key === "space") event.key_char = " ";
    else if ([...key].length === 1) event.key_char = modifiers.shift ? key.toUpperCase() : key;
  }
  return event;
}

// Handlers that later slices register: palette, quickopen, queue, recap, resume, pr, ticket,
// next-waiting, next:blocked, next:done, target (targets the built-in route leaves), relay
// (`relay:on|off|status`, views/shell/services.js → sys/relay.js command; the status copy only).

/** Registered handlers by command name (prefixed commands without their colon: `target`). */
export const handlers = Object.create(null);

/** Registers `fn(cx, {command, arg, copy})` for a command. `cx` belongs to the owner's command loop:
 *  use it right away or start work with cx.spawn; never keep it. A returned promise's failure is
 *  logged. Returns a function that removes this handler. */
export function handle(name, fn) {
  handlers[name] = fn;
  return () => {
    if (handlers[name] === fn) delete handlers[name];
  };
}

// Built-in routes. Each returns false to pass the command on.
const BUILTIN = {
  home: () => toggleHome(),
  "go:inbox": () => showCenter("inbox"),
  "go:todo": () => showCenter("todo"),
  "go:routines": () => showCenter("routines"),
  "go:assistant": () => showCenter("assistant"),
  "agent-view": () => toggleAgentView(),
  panel: () => togglePanel(),
  ...Object.fromEntries(PANELS.map((child) => [`panel:${child}`, () => togglePanelChild(child)])),
  target: (arg) => {
    if (!CENTER.includes(arg)) return false;
    showCenter(arg);
  },
  // The test hook and Herdr's focus go to the copy's own view only; a view without the method ignores them.
  key: (arg, copy, cx) => {
    copy.impl?.key?.(keyEvent(arg), cx);
  },
  // `assistant:<verb>` reaches every copy's command(); the Assistant views and the service act on it.
  assistant: (arg, copy, cx) => {
    if (copy.impl?.command) settle(copy.impl.command(`assistant:${arg}`, cx), `assistant:${arg}`);
  },
  focus: (_arg, copy, cx) => {
    copy.impl?.focus?.(cx);
  },
};

/** The file copy owns `file-mode` when its tab is the focused tab: the tab the view resolved
 *  (`impl.tab`), else the one the file-tab registry holds for its fid (§6). */
function ownsFocusedTab(copy) {
  const fid = copy.props?.fid;
  const registry = shared(KEY.tabs);
  const tab = copy.impl?.tab ?? (fid && registry && typeof registry === "object" ? registry[fid]?.tab : null);
  return Boolean(tab) && tab === focused()?.tab;
}

function owns(owner, copy) {
  if (owner === OWNER.self) return true;
  // A `preview: true` status copy (a plain tab Main opens to look at the view) only draws.
  if (owner === OWNER.status) return copy.name === "status" && copy.props?.preview !== true;
  if (owner === OWNER.file) return copy.name === "file" && ownsFocusedTab(copy);
  return false;
}

function settle(result, command) {
  if (result && typeof result.then === "function") result.then(undefined, (e) => log(`${command} failed: ${errText(e)}`));
}

/** Runs one command from nextCommand() in one copy. `copy` is the copy's main View: `{name, props, impl}`
 *  (`name` = props().view, `impl` = its view instance). */
export function dispatch(command, copy, cx) {
  const c = parseCommand(command);
  try {
    if (!c) {
      // Not in the table: a view's own command (e.g. one its overlay sends back), else nothing.
      if (copy.impl?.command) settle(copy.impl.command(command, cx), command);
      else if (copy.name === "status") log(`unknown command ${command}`);
      return;
    }
    if (!owns(c.owner, copy)) return;
    const builtin = BUILTIN[c.name];
    if (builtin && builtin(c.arg, copy, cx) !== false) return;
    const fn = handlers[c.name];
    if (fn) return settle(fn(cx, { command, arg: c.arg, copy }), command);
    if (copy.impl?.command) return settle(copy.impl.command(command, cx), command);
    log(`no handler for ${command}`);
  } catch (e) {
    log(`${command} failed: ${errText(e)}`);
  }
}
