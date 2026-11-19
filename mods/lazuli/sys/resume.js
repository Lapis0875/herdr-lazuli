// Session restore (DESIGN A7, ARCHITECTURE §7): a terminal that herdr-core gave a fresh shell (reboot, logout, a
// core crash: keep recovery keeps the address and labels, never the program) gets its Claude Code, Codex or OMP session
// back. Only kept top-level terminals (Herdr's panes) take part; helpers an agent started (`parent`) don't.
//   record:  a terminal whose foreground is one of the tools gets the LABEL {tool, session, argv, cwd, pid, tried}: the
//            session from the tool's own bookkeeping (FIND), argv without what picked a conversation, pid = the
//            terminal's own process (its shell), tried = null.
//   restore: a terminal back at its shell prompt whose process is no longer the recorded pid lost its program. The
//            label first records the attempt in `tried` (one automatic attempt per shell), then the resume command is
//            typed into the shell. The record's pid stays the old shell's until the same tool runs here on a session
//            discovered here (C6); another tool running there drops the record instead.
//   forget:  the tool gone from the same shell for FORGET_MS was quit on purpose: the label goes. The wait keeps a
//            shutdown, where tools often end before Herdr does, from forgetting what the next start restores.
// Terminals whose restore is pending, sent or failed go to the store `restore` (Home's lost agents); ⌥⌘R (`resume`)
// and retry() type the resume command again into every pending or failed terminal that sits at its shell.
//
// A port of lstack-herdr's lh-resume.js (removed; git history ee5201a).
// The status copy starts it: start(cx) in init, stop() in close.

import { terminals, spaces, hc, exec, notify, checking } from "herdr";
import {
  LABEL, TOOLS, toolOf, baseArgv, resumeArgv, shellLine, sessionFrom, encodeRecord, decodeRecord, restoreStatus,
} from "../core/resume-tools.js";
import { t } from "../core/i18n.js";
import { handle } from "./bus.js";
import { migrated } from "./migrate.js";
import { SESSION_RECORD } from "./scan.js";
import * as store from "./store.js";
import { STORE } from "./state.js";

const log = (msg) => console.log(`[lazuli/resume] ${msg}`);
const errText = (e) => e?.message ?? String(e);

const TICK_MS = 4000;
const FORGET_MS = 60000;
// A recorded terminal is looked at again when its tool, turn or status changes, and at least this often.
const RECHECK_MS = 60000;
// How long a label this module wrote wins over the live label, which follows `hc label` a moment later.
const WROTE_MS = 15000;

// Prints the session the tool process ($2, or a child) is on, or nothing. Args: tool, pid, OMP's reported session file.
//   claude: ~/.claude/sessions/<pid>.json names it; printed once its transcript exists (before the first message there
//           is nothing to resume).
//   codex:  the rollout file it holds open (created with the first message).
//   omp:    the SESSION_RECORD (`_lazuli`) record of the lazuli-tree extension when there is one, else the session file
//           it holds.
const FIND = String.raw`
tool="$1"; pid="$2"; hint="$3"
kids() { for k in $(pgrep -P "$1" 2>/dev/null); do echo "$k"; kids "$k"; done; }
held() {
  for p in "$pid" $(kids "$pid"); do
    if [ -d "/proc/$p/fd" ]; then for d in /proc/$p/fd/*; do readlink "$d"; done 2>/dev/null
    else lsof -p "$p" -Fn 2>/dev/null | sed -n 's/^n//p'; fi
  done | grep -E "$1" | head -1
}
case "$tool" in
  claude)
    j="$HOME/.claude/sessions/$pid.json"
    [ -f "$j" ] || exit 0
    id=$(sed -n 's/.*"sessionId" *: *"\([0-9a-fA-F-]*\)".*/\1/p' "$j" | head -1)
    [ -n "$id" ] || exit 0
    for f in "$HOME"/.claude/projects/*/"$id".jsonl; do [ -f "$f" ] && { echo "$id"; exit 0; }; done ;;
  codex) held '/rollout-[^/]*\.jsonl$' ;;
  omp)
    if [ -n "$hint" ]; then [ -f "$hint" ] && echo "$hint"; exit 0; fi
    held '/sessions/[^/]+/[^/]+\.jsonl$' ;;
esac
true`;

const machineOf = (address) => (address.includes("/") ? address.slice(0, address.indexOf("/")) : null);
const atShell = (t) => Boolean(t.foreground?.pid) && t.foreground.pid === t.pid;
const takesPart = (t) => t.state === "live" && Boolean(t.keep) && !t.parent && typeof t.address === "string";

/** An error with a code the toasts map to text: "send" (hc send failed) or "label" (hc label failed). */
function failure(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

// The running service; null while stopped. busy: terminals a step is working on; seen: what each recorded terminal
// looked like when last checked; gone: since when a recorded tool has been missing from its own shell; toasted:
// failures already shown; wrote: label texts this module wrote, until the live labels show them; ready: the
// migration has ended, so no old label is still waiting to become LABEL.
let svc = null;

/** Starts the watcher and the `resume` command (⌥⌘R). Call it from the status copy's init; it replaces a running one.
 *  The first tick waits for the migration (sys/migrate.js), which moves lstack-herdr's labels to LABEL. */
export function start(cx) {
  stop();
  if (checking()) return;
  const s = { busy: new Set(), seen: new Map(), gone: new Map(), toasted: new Set(), wrote: new Map(), ticking: false, ready: false, last: null, stops: [] };
  svc = s;
  s.stops.push(handle("resume", (cx) => {
    cx.spawn(async () => retry().catch((e) => log(`retry failed: ${errText(e)}`)));
  }));
  const run = (cx) => cx.spawn(async () => tick(s).catch((e) => log(`tick failed: ${errText(e)}`)));
  const task = cx.timer.every(TICK_MS, run);
  s.stops.push(() => task.cancel());
  cx.spawn(async () => {
    await migrated();
    s.ready = true;
    await tick(s).catch((e) => log(`tick failed: ${errText(e)}`));
  });
}

/** Stops the watcher and removes the `resume` command. Safe to call when stopped. */
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

async function setLabel(s, address, text) {
  const r = await hc(["label", address, `${LABEL}=${text}`]);
  if (r.code !== 0) throw failure("label", `hc label ${address}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  s.wrote.set(address, { text, at: Date.now() });
}

// The label text as it is now: what this module just wrote, until the live labels catch up.
function labelText(s, t) {
  const live = typeof t.labels?.[LABEL] === "string" ? t.labels[LABEL] : "";
  const w = s.wrote.get(t.address);
  if (!w) return live;
  if (w.text === live || Date.now() - w.at > WROTE_MS) {
    s.wrote.delete(t.address);
    return live;
  }
  return w.text;
}

const recordOf = (s, t) => decodeRecord(labelText(s, t));

/** Where a terminal sits, for people: its space and tab names, else its `where` label, else its address. */
function placeOf(t) {
  const machine = machineOf(t.address);
  const qualify = (id) => (typeof id === "string" && id ? (machine ? `${machine}/${id}` : id) : null);
  const spaceId = qualify(t.labels?.["herdr.space"]);
  const tabId = qualify(t.labels?.["herdr.tab"]);
  const space = spaceId ? spaces().find((p) => p.id === spaceId) ?? null : null;
  const tab = space && tabId ? space.tabs?.find((x) => x.id === tabId) ?? null : null;
  const label = typeof t.labels?.where === "string" && t.labels.where ? t.labels.where : t.address;
  const where = space ? (tab ? `${space.name} › ${tab.name}` : space.name) : label;
  return { space: space?.id ?? null, tab: tab?.id ?? null, where };
}

async function tick(s) {
  if (s.ticking || !s.ready || svc !== s) return;
  s.ticking = true;
  try {
    const now = Date.now();
    const restored = [];
    const failed = [];
    await Promise.all(terminals().filter(takesPart).map(async (t) => {
      if (s.busy.has(t.address)) return;
      s.busy.add(t.address);
      try {
        const r = await step(s, t, now);
        if (r) restored.push(r);
      } catch (e) {
        log(`${t.address}: ${errText(e)}`);
        if (e?.code === "send") failed.push({ key: `${t.address}|${t.pid}|send`, code: "send", where: placeOf(t).where });
      } finally {
        s.busy.delete(t.address);
      }
    }));
    toastRestored(restored);
    const value = publish(s);
    // A sent line whose tool never started fails by the clock, so it is found in the list, not as an error.
    for (const e of value?.failed ?? []) {
      if (e.reason === "timeout") failed.push({ key: `${e.address}|${e.tried}|timeout`, code: "timeout", where: e.where });
    }
    toastFailed(s, failed);
  } finally {
    s.ticking = false;
  }
}

/** One terminal's turn: record, restore or forget. Resolves with what it restored. */
async function step(s, t, now) {
  const tool = toolOf(t);
  const saved = recordOf(s, t);
  // A label in an older form, or one still carrying a credential option (decodeRecord drops it), is rewritten in the
  // form this version writes, so the credential leaves herdr-core's metadata too.
  if (saved && encodeRecord(saved) !== labelText(s, t)) await setLabel(s, t.address, encodeRecord(saved));
  if (tool) {
    s.gone.delete(t.address);
    await record(s, t, tool, saved, now);
    return null;
  }
  s.seen.delete(t.address);
  if (!saved) return null;
  if (t.pid !== saved.pid) {
    s.gone.delete(t.address);
    // One automatic attempt per shell, once its prompt shows; anything else in the foreground is the person's.
    return restoreStatus(t, saved, now) === "pending" && atShell(t) ? restore(s, t, saved, now) : null;
  }
  const since = s.gone.get(t.address) ?? now;
  s.gone.set(t.address, since);
  if (now - since >= FORGET_MS) {
    await setLabel(s, t.address, "");
    s.gone.delete(t.address);
  }
  return null;
}

/** A tool runs in the terminal: record its session. A record left from a lost shell (or with a restore attempt) is
 *  acknowledged only by the same tool on a session discovered here: the record is then rewritten for this shell (same
 *  session: recovered; another one: replaced). Until a session is found the old record stays as it is. Another tool
 *  drops it at once, so a later restart never brings the lost conversation back in its place. */
async function record(s, t, tool, saved, now) {
  let current = labelText(s, t);
  if (saved && (saved.pid !== t.pid || saved.tried) && saved.tool !== tool) {
    log(`${t.address}: ${tool} runs where ${saved.tool} was lost; its record is dropped`);
    await setLabel(s, t.address, "");
    current = "";
  }
  const fg = t.foreground;
  const reported = tool === "omp" ? t.records?.[SESSION_RECORD]?.msg : null;
  const hint = typeof reported === "string" ? reported : "";
  const sig = [tool, fg.pid, t.turn, t.status, hint].join("|");
  const last = s.seen.get(t.address);
  if (last?.sig === sig && now - last.at < RECHECK_MS) return;
  s.seen.set(t.address, { sig, at: now });
  const argv = baseArgv(tool, fg.argv);
  if (!argv) return;
  const r = await exec("sh", ["-c", FIND, "lazuli-resume", tool, String(fg.pid), hint], { on: machineOf(t.address), timeout: 10000 });
  const session = sessionFrom(tool, r.stdout);
  if (!session) return;
  const text = encodeRecord({ tool, session, argv, cwd: fg.cwd ?? t.cwd ?? null, pid: t.pid, tried: null });
  if (text !== current) await setLabel(s, t.address, text);
}

async function restore(s, t, saved, now) {
  // The attempt is recorded before anything is typed: a failed or interrupted attempt is not repeated by itself.
  const tried = { pid: t.pid, at: now, failed: false };
  await setLabel(s, t.address, encodeRecord({ ...saved, tried }));
  const here = t.foreground?.cwd ?? t.cwd;
  const line = shellLine(resumeArgv(saved.tool, saved.argv, saved.session), saved.cwd && saved.cwd !== here ? saved.cwd : null);
  let r;
  try {
    r = await hc(["send", t.address, line]);
  } catch (e) {
    r = { code: -1, stdout: "", stderr: errText(e) };
  }
  if (r.code !== 0) {
    await setLabel(s, t.address, encodeRecord({ ...saved, tried: { ...tried, failed: true } })).catch((e) => log(errText(e)));
    throw failure("send", `hc send ${t.address}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  }
  return { tool: saved.tool, where: placeOf(t).where };
}

function toastRestored(restored) {
  if (!restored.length) return;
  notify({
    title: t("shell.restore.restored", { count: restored.length }),
    body: restored.map((r) => `${TOOLS[r.tool].name} · ${r.where}`).join("\n"),
    level: "success",
    timeout: 8000,
  });
}

/** One error toast for the failures not shown before: `{key, code: "send"|"timeout", where}`. */
function toastFailed(s, failed) {
  const fresh = failed.filter((f) => !s.toasted.has(f.key));
  for (const f of fresh) s.toasted.add(f.key);
  if (!fresh.length) return;
  notify({
    title: t("shell.restore.failed"),
    body: fresh.map((f) => t(`shell.restore.reason.${f.code}`, { where: f.where })).join("\n"),
    level: "error",
    timeout: 10000,
  });
}

/** The restore list Home shows, as the store `restore` holds it:
 *  `{version: 1, pending: Entry[], failed: Entry[]}`, where pending holds "pending" and "sent" terminals and
 *  `Entry = {address, tool, name, session, cwd, space, tab, where, status: "pending"|"sent"|"failed",
 *  reason: null|"busy"|"send"|"timeout", atShell, tried: number|null}`. `busy`: pending while something other than
 *  its shell runs in the foreground; `send`: hc send failed; `timeout`: the tool had not started 30 s after the send. */
export function restoreList(now = Date.now()) {
  const s = svc;
  const pending = [];
  const failed = [];
  for (const term of terminals()) {
    if (!takesPart(term)) continue;
    const rec = s ? recordOf(s, term) : decodeRecord(term.labels?.[LABEL]);
    const status = restoreStatus(term, rec, now);
    if (!status) continue;
    const shell = atShell(term);
    const reason = status === "failed" ? (rec.tried?.failed ? "send" : "timeout") : status === "pending" && !shell ? "busy" : null;
    const entry = {
      address: term.address, tool: rec.tool, name: TOOLS[rec.tool].name, session: rec.session, cwd: rec.cwd,
      ...placeOf(term), status, reason, atShell: shell, tried: rec.tried?.at ?? null,
    };
    (status === "failed" ? failed : pending).push(entry);
  }
  return { version: 1, pending, failed };
}

// Puts the restore list in the store when it changed. Returns the list (null once stopped).
function publish(s) {
  if (svc !== s) return null;
  const value = restoreList();
  const text = JSON.stringify(value);
  if (text === s.last && store.has(STORE.restore)) return value;
  s.last = text;
  store.set(STORE.restore, value);
  return value;
}

/** Types the resume command again into every pending or failed terminal that sits at its shell (⌥⌘R), or only into
 *  `addresses` when given. Posts one toast with the outcome. Resolves with `{sent, busy, failed}` counts. */
export async function retry(addresses = null) {
  const s = svc;
  if (!s) return { sent: 0, busy: 0, failed: 0 };
  await migrated();
  const only = Array.isArray(addresses) ? new Set(addresses) : null;
  const now = Date.now();
  let busy = 0;
  const targets = [];
  for (const term of terminals()) {
    if (!takesPart(term) || (only && !only.has(term.address))) continue;
    const rec = recordOf(s, term);
    const status = restoreStatus(term, rec, now);
    if (status !== "pending" && status !== "failed") continue;
    if (!atShell(term) || s.busy.has(term.address)) busy += 1;
    else targets.push({ term, rec });
  }
  const restored = [];
  const failed = [];
  await Promise.all(targets.map(async ({ term, rec }) => {
    s.busy.add(term.address);
    try {
      restored.push(await restore(s, term, rec, now));
    } catch (e) {
      log(`${term.address}: ${errText(e)}`);
      const code = e?.code === "send" ? "send" : "label";
      failed.push({ key: `${term.address}|${term.pid}|${code}`, code, where: placeOf(term).where });
    } finally {
      s.busy.delete(term.address);
    }
  }));
  if (!restored.length && !failed.length && !busy) {
    notify({ title: t("shell.restore.nothing"), level: "info", timeout: 5000 });
  } else if (restored.length || busy) {
    const lines = restored.map((r) => `${TOOLS[r.tool].name} · ${r.where}`);
    if (busy) lines.push(t("shell.restore.busy", { count: busy }));
    notify({
      title: t("shell.restore.retried", { count: restored.length }),
      body: lines.join("\n"),
      level: restored.length ? "success" : "warning",
      timeout: 8000,
    });
  }
  if (failed.length) {
    notify({
      title: t("shell.restore.failed"),
      body: failed.map((f) => t(`shell.restore.reason.${f.code}`, { where: f.where })).join("\n"),
      level: "error",
      timeout: 10000,
    });
  }
  publish(s);
  return { sent: restored.length, busy, failed: failed.length };
}
