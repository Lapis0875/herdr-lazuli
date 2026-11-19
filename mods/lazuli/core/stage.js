// Whose move it is for each agent (ARCHITECTURE §4.2, CONTRACTS stage.js, C2): needs you, working, ready to land (its PR
// approved and green), done. Pure.

/** The stages, in the order the Home board shows them. */
export const STAGES = Object.freeze(["needs", "working", "ready", "done"]);

const FIX_CI = ["FAILURE", "ERROR"];

/** The stage of one agent. Rules in order: an active snooze → done; blocked → needs; working, or running subagents →
 *  working; its PR with changes requested, failing CI or unresolved threads → needs; approved, green, not a draft and
 *  its threads all read (`threadsPartial` not set) → ready; else done (so a PR whose threads could not all be read
 *  is never called ready to land). */
export function stageOf(a, now = 0) {
  const snoozed = a?.snoozedUntil;
  if (typeof snoozed === "number" && snoozed > now) return "done";
  const status = a?.status;
  if (status === "blocked") return "needs";
  const subagents = a?.subagents;
  if (status === "working" || (typeof subagents === "number" && subagents > 0)) return "working";
  const pr = a?.pr;
  if (pr && typeof pr === "object") {
    const threads = pr.threads;
    if (pr.review === "CHANGES_REQUESTED" || FIX_CI.includes(pr.ci) || (typeof threads === "number" && threads > 0)) return "needs";
    if (pr.review === "APPROVED" && pr.ci === "SUCCESS" && !pr.isDraft && pr.threadsPartial !== true) return "ready";
  }
  return "done";
}

/** How many agents each stage holds. */
export function counts(list) {
  const out = { needs: 0, working: 0, ready: 0, done: 0 };
  for (const a of Array.isArray(list) ? list : []) {
    const stage = a?.stage;
    if (STAGES.includes(stage)) out[stage] += 1;
  }
  return out;
}

/** The first address of that stage after `current` in list order, wrapping (current itself last); the first of the
 *  stage when `current` is not in the list; null when the stage is empty. */
export function nextInStage(list, stage, current) {
  const items = Array.isArray(list) ? list : [];
  const n = items.length;
  if (!n) return null;
  const start = (typeof current === "string" ? items.findIndex((a) => a?.address === current) : -1) + 1;
  for (let k = 0; k < n; k++) {
    const a = items[(start + k) % n];
    if (a?.stage === stage && typeof a.address === "string") return a.address;
  }
  return null;
}
