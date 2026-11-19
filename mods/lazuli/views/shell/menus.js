// The shell's context menus as item lists for views/shell/actions.js openMenu(): an agent's, a tab's, a space's, a
// pinned app's. Items are plain data (the menu overlay gets them as props); their actions are perform() descriptors.

import { shared } from "herdr";
import { KEY } from "../../sys/state.js";
import { t } from "../../core/i18n.js";
import { canFork, snoozeTimes } from "./actions.js";
import { agentName } from "./format.js";

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** An agent's actions: go to it, queue a prompt, recap, fork, snooze or wake, pin. `a` is a fleet row (or an agents()
 *  row with `address`, `pinned`). */
export function agentItems(a, now = Date.now()) {
  if (!a?.address) return [];
  const snoozed = shared(KEY.snooze);
  const until = isObj(snoozed) ? snoozed[a.address] : null;
  const asleep = typeof until === "number" && until > now;
  const times = snoozeTimes(now);
  const fork = canFork(a.address);
  return [
    { heading: agentName(a) },
    { label: t("shell.menu.agent.go"), icon: "terminal", action: { kind: "go", address: a.address } },
    { label: t("shell.menu.agent.queue"), icon: "send", kbd: "⌥⌘Q", action: { kind: "queue", address: a.address } },
    { label: t("shell.menu.agent.recap"), icon: "sparkles", kbd: "⌘R", action: { kind: "recap", address: a.address } },
    { separator: true },
    { label: t("shell.menu.agent.forkTab"), icon: "git-fork", disabled: !fork, action: { kind: "fork", address: a.address, place: "tab" } },
    { label: t("shell.menu.agent.forkRight"), icon: "columns", disabled: !fork, action: { kind: "fork", address: a.address, place: "right" } },
    { separator: true },
    ...(asleep
      ? [{ label: t("shell.menu.agent.wake"), icon: "alarm-clock", action: { kind: "snooze", address: a.address, until: null } }]
      : [
          { label: t("shell.menu.agent.snoozeHour"), icon: "alarm-clock", action: { kind: "snooze", address: a.address, until: times.hour } },
          ...(times.evening ? [{ label: t("shell.menu.agent.snoozeEvening"), icon: "clock", action: { kind: "snooze", address: a.address, until: times.evening } }] : []),
          { label: t("shell.menu.agent.snoozeMorning"), icon: "clock", action: { kind: "snooze", address: a.address, until: times.morning } },
        ]),
    { label: a.pinned ? t("shell.menu.agent.unpin") : t("shell.menu.agent.pin"), icon: "pin", checked: Boolean(a.pinned), action: { kind: "pin", address: a.address, pinned: !a.pinned } },
  ];
}

/** A tab's actions (Herdr's tab menu, in lazuli's words), then its agent's when it runs one. */
export function tabItems(space, tab, agent = null, now = Date.now()) {
  const own = [
    { heading: tab.name },
    { label: t("shell.menu.tab.rename"), icon: "square-pen", action: { kind: "run", run: "tab.rename", args: { id: tab.id } } },
    { label: t("shell.menu.tab.new"), icon: "plus", action: { kind: "run", run: "tab.new", args: { space: space.id } } },
    { label: t("shell.menu.tab.close"), icon: "x", danger: true, action: { kind: "run", run: "tab.close", args: { id: tab.id } } },
  ];
  if (!agent) return own;
  return [...own, { separator: true }, ...agentItems(agent, now).slice(1)];
}

/** A space's actions (Herdr's space menu, in lazuli's words). `checkout`: "main" or "linked" when its folder is a git
 *  checkout (the worktree dialog), null otherwise; `folder`: where its first terminal is now. */
export function spaceItems(space, checkout, folder) {
  const worktree = (action) => ({ kind: "overlay", spec: { mod: "worktree", kind: "dialog", props: { space: space.id, action, ...(folder ? { folder } : {}) } } });
  return [
    { heading: space.name },
    { label: t("shell.menu.space.rename"), icon: "square-pen", action: { kind: "run", run: "space.rename", args: { id: space.id } } },
    { label: t("shell.menu.space.newTab"), icon: "plus", action: { kind: "run", run: "tab.new", args: { space: space.id } } },
    ...(checkout
      ? [
          { separator: true },
          { label: t("shell.menu.space.newWorktree"), icon: "git-branch", action: worktree("new") },
          { label: t("shell.menu.space.openWorktree"), icon: "folder-git", action: worktree("open") },
          ...(checkout === "linked" ? [{ label: t("shell.menu.space.removeWorktree"), icon: "x", action: worktree("remove") }] : []),
        ]
      : []),
    { separator: true },
    ...(folder ? [{ label: t("shell.menu.space.editor"), icon: "code", action: { kind: "editor", path: folder, on: space.machine ?? null, folder: true } }] : []),
    { label: t("shell.menu.space.close"), icon: "x", danger: true, action: { kind: "run", run: "space.close", args: { id: space.id } } },
  ];
}

/** A pinned app's actions: open it, take it out of the sidebar, the settings where pins are chosen. */
export function pinItems(app, label) {
  return [
    { heading: label },
    { label: t("shell.menu.pin.open"), icon: "corner-down-left", action: { kind: "show", child: app } },
    { label: t("shell.menu.pin.unpin"), icon: "pin", action: { kind: "unpin-app", app } },
    { separator: true },
    { label: t("shell.menu.pin.settings"), icon: "settings", action: { kind: "settings" } },
  ];
}
