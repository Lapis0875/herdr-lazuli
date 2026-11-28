// What the Assistant views read out of the service's state that is drawing, not chat logic: the selected session,
// the running time, which approval still counts down, the model and mode names, the usage numbers and the plan's
// progress. The chat rules live in core/assistant-chat.js (`isRunning`, `rows`, `approvalButtons`, `canAnswer`), the
// list in core/assistant-list.js and the slash routing and / menu in core/assistant-agents.js; the views import
// those directly. Pure.

const list = (v) => (Array.isArray(v) ? v : []);
const obj = (v) => (v !== null && typeof v === "object" && !Array.isArray(v) ? v : {});

/** The selected row of the list, `{group, row}`, or null. */
export function selectedRow(state) {
  for (const group of list(state?.list?.groups)) {
    const row = list(group.rows).find((r) => r.selected);
    if (row) return { group, row };
  }
  return null;
}

/** The selected session's ChatState, or null. */
export function selectedChat(state) {
  const sel = selectedRow(state);
  return sel ? (obj(state?.sessions)[sel.row.key] ?? null) : null;
}

/** When the oldest unacknowledged request left, for the header's running time; null when none. */
export function runningSince(chat) {
  const ats = Object.values(obj(chat?.inflight))
    .filter((f) => !f?.acked)
    .map((f) => f?.at)
    .filter((n) => typeof n === "number");
  return ats.length ? Math.min(...ats) : null;
}

/** A permission's state as drawn at `now`: a pending one past its deadline reads as expired before the next tick
 *  marks it (K5 rule 4). */
export function permissionState(p, now = Date.now()) {
  if (p?.state === "pending" && typeof p.deadline === "number" && now >= p.deadline) return "expired";
  return p?.state ?? "pending";
}

/** Whole seconds left before a permission expires. */
export const secondsLeft = (p, now = Date.now()) => Math.max(0, Math.ceil(((p?.deadline ?? now) - now) / 1000));

/** The permissions still counting down at `now`, as `[requestId, permission]`. */
export function pendingPermissions(chat, now = Date.now()) {
  return Object.entries(obj(chat?.permissions)).filter(([, p]) => permissionState(p, now) === "pending");
}

/** Whether a session waits for an approval: the list row's "Needs you". */
export function waitsForYou(state, key, now = Date.now()) {
  return pendingPermissions(obj(state?.sessions)[key], now).length > 0;
}

/** Whether an unfinished tool card waits on an open approval: its own request, an edit approval holding its diff
 *  (K5 rule 3), or a command check of the newest running `execute` call (Hermes asks those as `perm-check-*`). */
export function toolWaits(chat, item, now = Date.now()) {
  if (!item || item.status === "completed" || item.status === "failed") return false;
  const open = pendingPermissions(chat, now).map(([, p]) => p);
  if (open.some((p) => p.toolCallId === item.id)) return true;
  if (item.kind === "edit" && item.diff && open.some((p) => String(p.toolCallId).startsWith("edit-approval-"))) return true;
  if (item.kind !== "execute" || !open.some((p) => String(p.toolCallId).startsWith("perm-check-"))) return false;
  const live = list(chat?.items).filter((it) => it.type === "tool" && it.kind === "execute" && it.status !== "completed" && it.status !== "failed");
  return live[live.length - 1]?.id === item.id;
}

/** The session's current model: `{id, name}` from ACP `models` (the name Hermes gives, else the id without its
 *  provider prefix). */
export function currentModel(chat) {
  const m = obj(chat?.models);
  const id = m.currentModelId ?? null;
  if (!id) return null;
  const found = list(m.availableModels).find((x) => x?.modelId === id);
  return { id, name: found?.name ?? String(id).replace(/^[^:]*:/, "") };
}

/** The models to pick from: `[{id, name, detail, current}]` (Hermes's " • current" mark left out of the detail). */
export function modelChoices(chat) {
  const m = obj(chat?.models);
  return list(m.availableModels).map((x) => ({ id: x.modelId, name: x.name ?? x.modelId, detail: String(x.description ?? "").replace(/\s*•\s*current\s*$/i, ""), current: x.modelId === m.currentModelId }));
}

/** The model a typed `/model <x>` names: one of this session's by id or name, else `x` as given. */
export function modelIdFor(chat, wanted) {
  const hit = list(chat?.models?.availableModels).find((m) => m?.modelId === wanted || m?.name === wanted);
  return hit?.modelId ?? wanted;
}

/** The session's mode name as Hermes names it ("Default"); read-only here (D31). */
export function currentMode(chat) {
  const m = obj(chat?.modes);
  const id = m.currentModeId ?? null;
  if (!id) return null;
  return list(m.availableModes).find((x) => x?.id === id)?.name ?? id;
}

/** Usage for the info view: context `{used, size, ratio}`, last reply `{input, output}`, totals `{tokens, calls}`,
 *  cost `{usd, status}`; each null when unknown. Totals and cost come from the session's `stats` (the sqlite row,
 *  core/assistant-list.js statsOf), else the list row's. */
export function usageOf(chat, row = null) {
  const u = obj(chat?.usage);
  const ctx = obj(u.context);
  const last = obj(u.lastTurn);
  const s = u.stats && typeof u.stats === "object" ? u.stats : row?.stats && typeof row.stats === "object" ? row.stats : null;
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const context = num(ctx.used) !== null && num(ctx.size) ? { used: ctx.used, size: ctx.size, ratio: Math.min(1, ctx.used / ctx.size) } : null;
  const lastTurn = num(last.inputTokens) !== null || num(last.outputTokens) !== null ? { input: num(last.inputTokens) ?? 0, output: num(last.outputTokens) ?? 0 } : null;
  let totals = null;
  let cost = null;
  if (s) {
    const parts = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "reasoningTokens"].map((f) => num(s[f]) ?? 0);
    const calls = num(s.apiCallCount);
    totals = calls || parts.some(Boolean) ? { tokens: parts.reduce((a, b) => a + b, 0), calls: calls ?? 0 } : null;
    const usd = num(s.actualCostUsd) ?? num(s.estimatedCostUsd);
    const status = typeof s.costStatus === "string" ? s.costStatus : "unknown";
    cost = { usd: status === "unknown" ? null : usd, status };
  }
  return { context, lastTurn, totals, cost };
}

/** The plan's progress: `{done, total, now}` with `now` the entry in progress (else the next pending one). */
export function planProgress(plan) {
  const entries = list(plan?.entries);
  return {
    done: entries.filter((e) => e?.status === "completed").length,
    total: entries.length,
    now: entries.find((e) => e?.status === "in_progress") ?? entries.find((e) => e?.status === "pending") ?? null,
  };
}

/** The bridge error of a profile (K4 `bridges[profile] = {state: "error", error}`), or null. */
export function bridgeError(state, profile) {
  const b = obj(state?.bridges)[profile];
  return b?.state === "error" ? (b.error ?? "bridge-launch-failed") : null;
}
