// How Routines words a routine and its runs: the schedule (describeWhen's code), why a run started, how it ended,
// what it left in its worktree, and the state glyph of a row. The codes come from core/routine-file.js,
// core/routine-sched.js and sys/routines.js; their texts are T12's `routines.*` keys.

import { t } from "../../core/i18n.js";
import { tokens } from "../../ui/tokens.js";
import { Icon, Spinner } from "../../ui/kit.js";
import { clock } from "./fmt.js";

/** A `when` as words: `{code, vars}` from describeWhen (or a row's `when`). */
export function whenText(w) {
  if (!w) return t("routines.when.manual");
  if (w.code === "error") return t(`routines.when-error.${w.vars?.error ?? "when-unknown"}`, { detail: w.vars?.detail ?? "" });
  if (w.code === "on") {
    const trigger = t(`routines.trigger.${w.vars?.trigger ?? "any"}`);
    return w.vars?.words ? t("routines.when.on-words", { trigger, words: w.vars.words }) : t("routines.when.on", { trigger });
  }
  return t(`routines.when.${w.code}`, w.vars ?? {});
}

/** Why a run started. */
export function whyText(why) {
  const time = typeof why?.at === "number" ? clock(why.at) : "";
  switch (why?.kind) {
    case "schedule":
      return t(why.late ? "routines.why.schedule-late" : "routines.why.schedule", { time });
    case "interval":
      return t("routines.why.interval");
    case "event":
      return t("routines.why.event", { title: why.title ?? "" });
    default:
      return t("routines.why.manual");
  }
}

const RUN_ERRORS = new Set(["lost", "timed-out", "no-folder", "unknown-agent", "no-routine", "worktree-no-repo", "worktree", "write", "hc-run", "start", "spawn"]);

/** A record's error code as words (`spawn: ENOENT` keeps its detail). */
export function runError(error) {
  const text = String(error ?? "");
  const at = text.indexOf(":");
  const code = at > 0 ? text.slice(0, at).trim() : text.trim();
  const detail = at > 0 ? text.slice(at + 1).trim() : "";
  return RUN_ERRORS.has(code) ? t(`routines.run-error.${code}`, { detail }) : text;
}

/** How a run ended: `{text, tone}`. `timeout`: the routine's minutes, for a run that timed out. */
export function endText(rec, timeout) {
  if (rec.missed) return { text: t("routines.run.missed"), tone: "warning" };
  if (rec.timedOut) return { text: t("routines.run.timed-out", { n: timeout ?? 30 }), tone: "error" };
  if (rec.stopped) return { text: t("routines.run.stopped"), tone: "tertiary" };
  if (rec.ok) return { text: t("routines.run.ok"), tone: "success" };
  if (rec.error) return { text: runError(rec.error), tone: "error" };
  return { text: typeof rec.code === "number" ? t("routines.run.failed-code", { code: rec.code }) : t("routines.run.failed"), tone: "error" };
}

/** What a run left in its worktree, or null. */
export function worktreeText(wt, removed = false) {
  if (!wt) return null;
  if (wt.removed || removed) return t("routines.worktree.removed");
  if (wt.dirty) return t("routines.worktree.dirty");
  return t("routines.worktree.kept", { commits: wt.commits ?? 0 });
}

/** A routine row's state: `running`, `queued`, `broken`, `paused`, `failed`, `ok` or `never`. */
export function stateOf(r) {
  if (r.running) return "running";
  if (r.queued) return "queued";
  if (r.error) return "broken";
  if (r.paused) return "paused";
  if (!r.last) return "never";
  return r.last.ok ? "ok" : r.last.missed ? "missed" : "failed";
}

const GLYPH = {
  queued: ["hourglass", "warning"],
  broken: ["triangle-alert", "error"],
  paused: ["circle-pause", "tertiary"],
  never: ["circle-dashed", "tertiary"],
  ok: ["circle-check", "success"],
  missed: ["skip-forward", "warning"],
  failed: ["circle-x", "error"],
};

/** The glyph of a state. */
export function StateGlyph(state, { size = 14 } = {}) {
  const k = tokens();
  if (state === "running") return Spinner({ size, color: k.state.working, label: t("routines.run.running") });
  const [icon, tone] = GLYPH[state] ?? GLYPH.never;
  return Icon(icon, { size, color: tone === "tertiary" ? k.text.tertiary : k.state[tone] });
}
