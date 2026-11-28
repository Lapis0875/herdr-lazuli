// Notifications (DESIGN A8, ARCHITECTURE §7, spike S2). Sources: an agent turning blocked or done (once per
// address + status + seq), a routine's end (the notices sys/routines.js puts in the store `routines`, already filtered
// by each routine's `notify` policy), GitHub events (the latest diff batch in the store `gh`) and the Assistant's
// notices (sys/assistant.js onNotice: an approval request, a finished or failed turn; it already leaves out the
// session the person is looking at, K7). An Assistant notice opens `lazuli.target:assistant:<profile>:<session>`.
//
// | Window     | System notifications                         | Delivery                                              |
// |------------|----------------------------------------------|-------------------------------------------------------|
// | active     | any                                          | notify() toast, its click runs `lazuli.target:<target>` |
// | not active | terminal-notifier authorized, posted exit 0  | system banner; a click activates Herdr and, for an    |
// |            |                                              | agent, runs `herdr-app do agent.focus --terminal <a>`;  |
// |            |                                              | for an Assistant session, `do lazuli.target:<target>` |
// | not active | missing, not asked yet, denied, off, failed  | notify() toast + setBadge(count of these)             |
//
// Herdr posts its own toast when an agent needs the person or finished while they weren't looking (herdr.d.ts,
// notify), so agent changes never get a second in-window toast: while active nothing is posted for them, and the
// fallback only counts them on the badge.
//
// terminal-notifier (S2): `-diagnose` runs once per start, its `authorization` line cached; it runs again at most every
// RECHECK_MS while not authorized. A post never runs under exec's default 30 s timeout: the first post of a fresh
// install opens macOS's permission prompt, and killing it there left the permission denied. Background posts happen
// only when authorized and get POST_TIMEOUT_MS; asking for the permission is requestPermission(), from the settings
// view. Exit 3 (notifications turned off) or any failure takes the fallback.
//
// The status copy starts it: start(cx) in init, stop() in close.

import { agents, window as appWindow, notify as toast, setBadge, exec, checking, home, appHome, run } from "herdr";
import { t } from "../core/i18n.js";
import { quote } from "../core/resume-tools.js";
import { handle } from "./bus.js";
import * as store from "./store.js";
import { STORE } from "./state.js";
import * as assistant from "./assistant.js";

const log = (msg) => console.log(`[lazuli/notify] ${msg}`);
const errText = (e) => e?.message ?? String(e);
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

const TICK_MS = 2000;
const PROBE_TIMEOUT_MS = 8000;
const POST_TIMEOUT_MS = 10000;
const PERMISSION_TIMEOUT_MS = 600000;
const RECHECK_MS = 600000;
const TOAST_MS = 8000;
/** Herdr's bundle id (/Applications/Herdr.app/Contents/Info.plist), activated by a click on a banner. */
const BUNDLE = "dev.herdr.app";
/** A terminal address safe to put in the click's shell command (ARCHITECTURE §7). */
const ADDRESS = /^[A-Za-z0-9._/-]+$/;
/** More GitHub events than this in one batch post one summary. */
const GH_SINGLE = 3;
const BODY_MAX = 400;

const GH_LEVEL = Object.freeze({
  review_requested: "info", pr_opened: "info", approved: "success", changes_requested: "warning", merged: "success",
  ci_failed: "error", ci_passed: "success",
});
const ROUTINE_LEVEL = Object.freeze({ ok: "success", failed: "error", missed: "warning", "over-budget": "warning" });

/** The store holding the system-notification state for the settings view: `{state, checkedAt}` (no snapshot). */
export const NOTIFY_STORE = "notify";

/** States of system notifications, and the catalog key the settings view shows for each:
 *  `unknown` and `checking` (not known yet), `authorized`, `disabled` (off in lazuli's settings), `missing`
 *  (terminal-notifier not installed), `not-requested` (macOS never asked; requestPermission() asks), `denied`
 *  (turned off in System Settings), `failed` (it did not answer). */
export const SYSTEM_TEXT = Object.freeze({
  unknown: "shell.notify.system.checking",
  checking: "shell.notify.system.checking",
  authorized: "shell.notify.system.on",
  disabled: "shell.notify.system.off",
  missing: "shell.notify.system.missing",
  "not-requested": "shell.notify.system.notRequested",
  denied: "shell.notify.system.denied",
  failed: "shell.notify.system.failed",
});

// terminal-notifier and herdr-app as found on this start, and the permission `-diagnose` reported.
const system = { state: "unknown", checkedAt: 0, bin: null, herdrApp: null };
let probing = null;

// The Dock badge this module set: how many notices went to the fallback since the window was last active.
let badge = 0;

/** What system notifications do now: `{state, checkedAt}`; `state` is a key of SYSTEM_TEXT. Safe in render(). */
export function systemStatus() {
  return { state: store.settings().notifications.system === false ? "disabled" : system.state, checkedAt: system.checkedAt || null };
}

function setSystem(change) {
  Object.assign(system, change);
  if (change.state && change.state !== "checking") system.checkedAt = Date.now();
  const value = systemStatus();
  if (JSON.stringify(value) !== JSON.stringify(store.get(NOTIFY_STORE))) store.set(NOTIFY_STORE, value, { snapshot: false });
}

/** The `authorization` line of `terminal-notifier -diagnose`: "denied", "not-requested", or "authorized" for any other
 *  value (3.1.0 prints `authorized`, exit 0, once allowed: seen on this Mac 2026-11-19); "failed" without one. */
export function authorizationOf(text) {
  const m = /^[ \t]*authorization[ \t]+(.+?)[ \t]*$/im.exec(String(text ?? ""));
  if (!m) return "failed";
  const value = m[1].toLowerCase();
  if (value.includes("denied")) return "denied";
  if (value.includes("not requested") || value.includes("not determined")) return "not-requested";
  return "authorized";
}

/** Finds terminal-notifier and herdr-app and reads the permission (`-diagnose`). Resolves with systemStatus(). */
export function recheck() {
  if (checking()) return Promise.resolve(systemStatus());
  if (!probing) {
    probing = probe()
      .catch((e) => {
        log(`probe failed: ${errText(e)}`);
        setSystem({ state: "failed" });
      })
      .then(() => systemStatus())
      .finally(() => {
        probing = null;
      });
  }
  return probing;
}

async function probe() {
  setSystem({ state: "checking" });
  let found = "";
  try {
    const r = await exec("sh", ["-c", 'printf "%s\\n%s\\n" "$(command -v terminal-notifier)" "$(command -v herdr-app)"'], { timeout: PROBE_TIMEOUT_MS });
    found = r.stdout;
  } catch (e) {
    log(`lookup failed: ${errText(e)}`);
  }
  const [bin = "", herdrApp = ""] = found.split("\n").map((s) => s.trim());
  const where = { bin: bin || null, herdrApp: herdrApp || `${home()}/.local/bin/herdr-app` };
  if (!bin) {
    setSystem({ ...where, state: "missing" });
    return;
  }
  let r;
  try {
    r = await exec(bin, ["-diagnose"], { timeout: PROBE_TIMEOUT_MS });
  } catch (e) {
    log(`-diagnose failed: ${errText(e)}`);
    setSystem({ ...where, state: "failed" });
    return;
  }
  setSystem({ ...where, state: authorizationOf(`${r.stdout}\n${r.stderr}`) });
}

/** Asks macOS for the permission with one test post (S2: never under a short timeout, since the prompt waits for the
 *  person), then reads it again. For the settings view's "Enable system notifications" button, inside cx.spawn.
 *  Resolves with systemStatus(). */
export async function requestPermission() {
  if (checking()) return systemStatus();
  await recheck();
  if (!system.bin) return systemStatus();
  setSystem({ state: "checking" });
  try {
    const args = ["-title", "lazuli", "-message", text(t("shell.notify.system.test")), "-group", "lazuli:permission", "-activate", BUNDLE];
    const r = await exec(system.bin, args, { timeout: PERMISSION_TIMEOUT_MS });
    if (r.code !== 0) log(`permission post: exit ${r.code}`);
  } catch (e) {
    log(`permission post failed: ${errText(e)}`);
  }
  return recheck();
}

const systemOn = () => store.settings().notifications.system !== false && system.state === "authorized" && Boolean(system.bin);

function maybeRecheck() {
  if (probing || system.state === "authorized" || store.settings().notifications.system === false) return;
  if (Date.now() - system.checkedAt >= RECHECK_MS) recheck();
}

// A banner's text: terminal-notifier reads a leading "[" only escaped (its -help), and a leading "-" as an option.
function text(s) {
  const one = String(s ?? "").slice(0, BODY_MAX);
  if (one.startsWith("[")) return `\\${one}`;
  if (one.startsWith("-")) return `\u200b${one}`;
  return one;
}

// The click's shell command for an agent: Herdr focuses it, with the app home this window uses.
function focusCommand(address) {
  if (typeof address !== "string" || !ADDRESS.test(address) || !system.herdrApp) return null;
  return `env HERDR_APP_HOME=${quote(appHome())} ${quote(system.herdrApp)} do agent.focus --terminal ${quote(address)}`;
}

// The click's shell command for an Assistant session: lazuli shows it (`lazuli.target:assistant:<p>:<s>`, run by the
// always-shown status copy, S2). Only a well-formed target goes into the command.
function targetCommand(target) {
  if (!assistant.parseTarget(target) || !system.herdrApp) return null;
  return `env HERDR_APP_HOME=${quote(appHome())} ${quote(system.herdrApp)} do ${quote(`lazuli.target:${target}`)}`;
}

// Resolves true when the banner was posted. An authorized post returns at once (77 ms with -execute, exit 0, measured
// on this Mac 2026-11-19), so one that runs into POST_TIMEOUT_MS waits on something else, such as a permission
// prompt after the permission was reset: that and every other failure take the fallback until the next recheck.
async function postSystem(n) {
  const args = ["-title", "lazuli", "-subtitle", text(n.title), "-message", text(n.body || n.title), "-group", `lazuli:${n.key}`, "-activate", BUNDLE];
  const click = focusCommand(n.agent) ?? targetCommand(n.target);
  if (click) args.push("-execute", click);
  try {
    const r = await exec(system.bin, args, { timeout: POST_TIMEOUT_MS });
    if (r.code === 0) return true;
    log(`post: exit ${r.code}`);
    setSystem({ state: r.code === 3 ? "denied" : "failed" });
  } catch (e) {
    log(`post failed: ${errText(e)}`);
    setSystem({ state: "failed" });
  }
  return false;
}

function inWindow(n) {
  toast({
    title: n.title,
    ...(n.body ? { body: n.body } : {}),
    level: n.level,
    timeout: n.level === "error" ? TOAST_MS + 4000 : TOAST_MS,
    ...(n.target ? { action: { name: `lazuli.target:${n.target}` } } : {}),
  });
}

function fallback(n) {
  if (!n.agent) inWindow(n);
  badge += 1;
  setBadge(String(badge));
}

function clearBadge() {
  if (!badge) return;
  badge = 0;
  setBadge(null);
}

/** Delivers one notice as the window and system notifications allow (table above). `n = {key, title, body, level,
 *  target, agent?}`: `key` groups banners (a newer one with the same key replaces the older), `target` is what a
 *  toast's click opens (`lazuli.target:<target>`), `agent` the terminal address of an agent notice. */
function deliver(n) {
  if (appWindow().active) {
    if (!n.agent) inWindow(n);
    return;
  }
  if (!systemOn()) {
    maybeRecheck();
    fallback(n);
    return;
  }
  postSystem(n)
    .then((ok) => {
      if (!ok) fallback(n);
    })
    .catch((e) => {
      log(`deliver failed: ${errText(e)}`);
      fallback(n);
    });
}

// The running service; null while stopped.
let svc = null;

/** Starts the notification sources and the `target` command (toast clicks). Call it from the status copy's init; it
 *  replaces a running one. */
export function start(cx) {
  stop();
  if (checking()) return;
  const startedAt = Date.now();
  const s = { startedAt, ghAt: startedAt, status: new Map(), posted: new Set(), primed: false, notices: new Set(), stops: [] };
  svc = s;
  s.stops.push(handle("target", (cx, { arg }) => follow(arg, cx)));
  s.stops.push(store.subscribe(STORE.gh, (value) => onGh(s, value)));
  s.stops.push(store.subscribe(STORE.routines, (value) => onRoutines(s, value)));
  s.stops.push(assistant.onNotice((n) => onAssistant(s, n)));
  const task = cx.timer.every(TICK_MS, () => watch(s));
  s.stops.push(() => task.cancel());
  watch(s);
  cx.spawn(async () => recheck());
}

/** Stops the sources, removes the `target` command and clears the badge this module set. */
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
  clearBadge();
}

/** What a toast's click asks, past the bus's own targets (the center views): `agent:<address>` focuses that agent;
 *  `assistant:<profile>:<session>` shows the Assistant with that session selected (K7). */
function follow(target, cx) {
  const arg = String(target ?? "");
  if (arg.startsWith("agent:") && ADDRESS.test(arg.slice(6))) {
    run("agent.focus", { terminal: arg.slice(6) });
    return;
  }
  const chat = assistant.parseTarget(arg);
  if (chat) {
    assistant.openTarget(cx, chat.profile, chat.sessionId);
    return;
  }
  log(`unknown target ${arg}`);
}

const ASSISTANT_LEVEL = Object.freeze({ permission: "warning", done: "success", failed: "error" });

// The Assistant: each notice as it is raised (sys/assistant.js decides when one is due).
function onAssistant(s, n) {
  if (svc !== s || !isPlain(n) || !own(ASSISTANT_LEVEL, n.kind)) return;
  const cut = typeof n.key === "string" ? n.key.indexOf("/") : -1;
  if (cut < 0) return;
  const target = `assistant:${n.key.slice(0, cut)}:${n.key.slice(cut + 1)}`;
  if (!assistant.parseTarget(target)) return;
  deliver({
    key: `assistant:${n.key}`,
    title: t(`assistant.notice.${n.kind}`, { title: n.title || t("assistant.list.untitled") }),
    body: typeof n.body === "string" ? n.body : "",
    level: ASSISTANT_LEVEL[n.kind],
    target,
  });
}

const agentName = (a) => a.program?.name || a.app || a.title || a.address;

// Agents: a change to blocked or done, once per address + status + seq. The first look only learns the statuses.
function watch(s) {
  if (svc !== s) return;
  if (appWindow().active) clearBadge();
  const live = new Set();
  for (const a of agents()) {
    live.add(a.address);
    const before = s.status.get(a.address);
    s.status.set(a.address, a.status);
    if (!s.primed || before === a.status || (a.status !== "blocked" && a.status !== "done")) continue;
    const once = `${a.address}|${a.status}|${a.seq}`;
    if (s.posted.has(once)) continue;
    s.posted.add(once);
    const place = [a.space_name, a.tab_name].filter(Boolean).join(" › ");
    deliver({
      key: `agent:${a.address}`,
      agent: a.address,
      title: t(`shell.notify.agent.${a.status}`, { agent: agentName(a) }),
      body: [place, a.title].filter(Boolean).join("\n"),
      level: a.status === "blocked" ? "warning" : "success",
      target: `agent:${a.address}`,
    });
  }
  s.primed = true;
  for (const address of [...s.status.keys()]) if (!live.has(address)) s.status.delete(address);
  for (const once of [...s.posted]) if (!live.has(once.slice(0, once.indexOf("|")))) s.posted.delete(once);
}

// GitHub: each new batch once (`eventsAt` moves only with a fresh, non-empty batch; a snapshot is older than start).
function onGh(s, value) {
  if (svc !== s || !isPlain(value) || typeof value.eventsAt !== "number" || value.eventsAt <= s.ghAt) return;
  s.ghAt = value.eventsAt;
  const events = (Array.isArray(value.events) ? value.events : []).filter((e) => isPlain(e) && own(GH_LEVEL, e.kind));
  if (events.length > GH_SINGLE) {
    deliver({
      key: "gh",
      title: t("shell.notify.gh.many", { count: events.length }),
      body: events.slice(0, 5).map((e) => `${t(`shell.notify.gh.${e.kind}`)} · ${e.title ?? ""}`).join("\n"),
      level: events.some((e) => GH_LEVEL[e.kind] === "error") ? "error" : "info",
      target: "inbox",
    });
    return;
  }
  for (const e of events) {
    deliver({
      key: `gh:${e.key ?? e.url ?? e.title}`,
      title: t(`shell.notify.gh.${e.kind}`),
      body: typeof e.title === "string" ? e.title : "",
      level: GH_LEVEL[e.kind],
      target: "inbox",
    });
  }
}

// Routines: each notice id once, and only notices made since this start (a snapshot replays older ones).
function onRoutines(s, value) {
  if (svc !== s) return;
  const notices = isPlain(value) && Array.isArray(value.notices) ? value.notices : [];
  const ids = new Set();
  for (const n of [...notices].reverse()) {
    if (!isPlain(n) || typeof n.id !== "string") continue;
    ids.add(n.id);
    if (s.notices.has(n.id) || typeof n.at !== "number" || n.at < s.startedAt || !own(ROUTINE_LEVEL, n.kind)) continue;
    s.notices.add(n.id);
    deliver({
      key: `routine:${n.slug}`,
      title: t(`shell.notify.routine.${n.kind}`, { name: n.name || n.slug }),
      body: typeof n.summary === "string" ? n.summary : "",
      level: ROUTINE_LEVEL[n.kind],
      target: "routines",
    });
  }
  for (const id of [...s.notices]) if (!ids.has(id)) s.notices.delete(id);
}
