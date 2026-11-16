// Session restore, run by the always-shown status bar: a terminal that herdr-core gave a fresh shell (reboot, logout,
// a core crash: keep recovery keeps the address and labels, never the program) gets its Claude Code, Codex or OMP
// session back. Only kept top-level terminals (Herdr's panes) take part; helpers an agent started (`parent`) don't.
//   record:  a terminal whose foreground is one of the tools gets the LABEL {tool, session, argv, cwd, pid}: the
//            session from the tool's own bookkeeping (FIND), argv without what picked a conversation, pid = the
//            terminal's own process (its shell).
//   restore: a terminal back at its shell prompt whose process is no longer the recorded pid lost its program. The
//            label moves to the new pid first (one attempt per loss), then the resume command is typed into the shell.
//   forget:  the tool gone from the same shell for FORGET_MS was quit on purpose: the label goes. The wait keeps a
//            shutdown, where tools often end before Herdr does, from forgetting what the next start restores.

import { terminals, hc, exec, notify, checking } from "herdr";
import { LABEL, TOOLS, toolOf, baseArgv, resumeArgv, shellLine, sessionFrom, encodeRecord, decodeRecord } from "./lh-resume-tools.js";

const TICK_MS = 4000;
const FORGET_MS = 60000;
// A recorded terminal is looked at again when its tool, turn or status changes, and at least this often.
const RECHECK_MS = 60000;

// Prints the session the tool process ($2, or a child) is on, or nothing. Args: tool, pid, OMP's reported session file.
//   claude: ~/.claude/sessions/<pid>.json names it; printed once its transcript exists (before the first message there
//           is nothing to resume).
//   codex:  the rollout file it holds open (created with the first message).
//   omp:    the `_session` record of the lstack-herdr-tree extension when there is one, else the session file it holds.
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

async function setLabel(address, value) {
  const r = await hc(["label", address, `${LABEL}=${value}`]);
  if (r.code !== 0) throw new Error(`hc label ${address}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
}

/** Starts the watcher in the status bar's copy (one per layout, always alive). */
export function lhResume(cx) {
  if (checking()) return;
  // busy: terminals a step is still working on; seen: what each recorded terminal looked like when last checked;
  // gone: since when a recorded tool has been missing from its own shell; toasted: errors already shown.
  const state = { busy: new Set(), seen: new Map(), gone: new Map(), toasted: new Set() };
  cx.timer.every(TICK_MS, (cx) => cx.spawn(async () => tick(state)));
}

async function tick(state) {
  const now = Date.now();
  const restored = [];
  const failed = [];
  await Promise.all(terminals().map(async (t) => {
    if (t.state !== "live" || !t.keep || t.parent || state.busy.has(t.address)) return;
    state.busy.add(t.address);
    try {
      const r = await step(state, t, now);
      if (r) restored.push(r);
    } catch (e) {
      failed.push(`${t.labels?.where ?? t.address}: ${e?.message ?? e}`);
    } finally {
      state.busy.delete(t.address);
    }
  }));
  const where = (r) => `${TOOLS[r.tool].name} · ${r.where}`;
  if (restored.length) notify({ title: `이전 세션 ${restored.length}개를 복원했습니다`, body: restored.map(where).join("\n"), level: "success", timeout: 8000 });
  const fresh = failed.filter((f) => !state.toasted.has(f));
  for (const f of fresh) state.toasted.add(f);
  if (fresh.length) notify({ title: "세션 복원 오류", body: fresh.join("\n"), level: "error", timeout: 10000 });
}

/** One terminal's turn: record, restore or forget. Resolves with what it restored. */
async function step(state, t, now) {
  const tool = toolOf(t);
  if (tool) {
    state.gone.delete(t.address);
    await record(state, t, tool, now);
    return null;
  }
  state.seen.delete(t.address);
  const saved = decodeRecord(t.labels?.[LABEL]);
  if (!saved) return null;
  if (t.pid !== saved.pid) {
    // Wait for the fresh shell's prompt; anything else in the foreground is the person's.
    return t.foreground?.pid === t.pid ? restore(t, saved) : null;
  }
  const since = state.gone.get(t.address) ?? now;
  state.gone.set(t.address, since);
  if (now - since >= FORGET_MS) {
    await setLabel(t.address, "");
    state.gone.delete(t.address);
  }
  return null;
}

async function record(state, t, tool, now) {
  const fg = t.foreground;
  const hint = tool === "omp" && typeof t.records?._session?.msg === "string" ? t.records._session.msg : "";
  const sig = [tool, fg.pid, t.turn, t.status, hint].join("|");
  const last = state.seen.get(t.address);
  if (last?.sig === sig && now - last.at < RECHECK_MS) return;
  state.seen.set(t.address, { sig, at: now });
  const argv = baseArgv(tool, fg.argv);
  if (!argv) return;
  const r = await exec("sh", ["-c", FIND, "lh-resume", tool, String(fg.pid), hint], { on: machineOf(t.address), timeout: 10000 });
  const session = sessionFrom(tool, r.stdout);
  if (!session) return;
  const text = encodeRecord({ tool, session, argv, cwd: fg.cwd ?? t.cwd ?? null, pid: t.pid });
  if (text !== t.labels?.[LABEL]) await setLabel(t.address, text);
}

async function restore(t, saved) {
  // The label follows the new shell before anything is typed: a failed or interrupted attempt is not repeated.
  await setLabel(t.address, encodeRecord({ ...saved, pid: t.pid }));
  const here = t.foreground?.cwd ?? t.cwd;
  const line = shellLine(resumeArgv(saved.tool, saved.argv, saved.session), saved.cwd && saved.cwd !== here ? saved.cwd : null);
  const r = await hc(["send", t.address, line]);
  if (r.code !== 0) throw new Error(`hc send ${t.address}: ${(r.stderr || r.stdout).trim() || `exit ${r.code}`}`);
  return { tool: saved.tool, where: t.labels?.where ?? t.address };
}
