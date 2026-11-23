// One Assistant session's chat state (CONTRACTS K5): a reducer over ACP `session/update` bodies, agent
// permission requests and the service's own events, plus the rows the transcript draws. Pure: time is an
// argument, inputs are never changed, and an event that changes nothing returns the same state object.
//
// Events (`{type, ...}`):
//   update {update}                       a `session/update` body (`params.update`)
//   permission {requestId, toolCall, options, at}   `session/request_permission`; `at` = bridge receive time
//   permission-answered {requestId, optionId}       optionId null/absent = cancelled by lazuli
//   prompt-sent {requestId, kind: prompt|steer|command, text?, attachments?, via?, again?}
//                                         no text and no attachments = restore an in-flight entry only;
//                                         `again` = the user item only (a running turn applied again after a load)
//   prompt-done {requestId, stopReason, usage}      prompt-failed {requestId, error}
//   queued {text, chipId?}  unqueued {chipId}  queue-paused  queue-resumed  queue-flush {requestId, chipId?}
//   load-start  loaded {models, modes}  model-set {modelId}  stats {stats}  gap  disconnected  tick
//   agent-error {text}                    an error line the agent wrote to stderr (the bridge's `agent-error`)
//   notice {code, vars?}                  a notice of the service's own (e.g. `busy`)
//
// Notice codes (`notice{code, vars}`, catalog `assistant.event.<code>`): steer-ack {preview},
// steer-queued {depth}, steer-failed {detail}, cancelled, stopped {detail: stop reason}, failed {detail},
// too-late, dropped {count}, model-set {model}, gap.
//
// Rule 11: a prompt's turn that ends (`end_turn`) with no assistant text, no tool item and no permission since the
// prompt was sent adds `failed {detail}` with the newest `agent-error` text of that turn, or NO_REPLY when there was
// none (Hermes ends a failed turn with `end_turn` and no message; its error goes to stderr). An error line that comes
// just after such a notice fills in its NO_REPLY detail (stderr and stdout are separate pipes).

import { PERMISSION_TIMEOUT_MS, agentOf, steerReply } from "./assistant-agents.js";
import { normalize } from "./paths.js";

/** At most this many transcript items; the oldest are dropped behind one `dropped` notice. */
export const MAX_ITEMS = 2000;
/** Characters kept per user, assistant or thought message. */
export const MAX_MESSAGE = 400000;
/** Characters kept per tool text (content text, raw output); diffs are kept whole. */
export const MAX_TOOL_TEXT = 20000;
/** Rule 11's detail when a reply-less turn left no error text. */
export const NO_REPLY = "no-reply";
/** Characters kept of an `agent-error` text. */
const MAX_ERROR = 2000;

const KINDS = new Set(["prompt", "steer", "command"]);
const VIAS = new Set(["prompt", "steer", "queue", "replay"]);
const STATUSES = new Set(["pending", "in_progress", "completed", "failed"]);
const ENDED = new Set(["completed", "failed"]);
const EDIT_APPROVAL = "edit-approval-";

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const str = (v) => (typeof v === "string" ? v : "");
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** `text` cut to `max` characters, never splitting a surrogate pair. */
function clip(text, max) {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/** A new session's state. `key` is `<profile>/<sessionId>`; `meta` may carry profile, sessionId, agent,
 *  title, updatedAt (ms), loaded, models and modes. */
export function emptyChat(key, meta = {}) {
  const k = String(key ?? "");
  const cut = k.indexOf("/");
  const m = isPlain(meta) ? meta : {};
  return {
    key: k,
    profile: typeof m.profile === "string" ? m.profile : cut > 0 ? k.slice(0, cut) : null,
    sessionId: typeof m.sessionId === "string" ? m.sessionId : cut > 0 ? k.slice(cut + 1) : null,
    agent: typeof m.agent === "string" ? m.agent : "hermes",
    loaded: m.loaded === true,
    stale: false,
    title: typeof m.title === "string" ? m.title : null,
    updatedAt: num(m.updatedAt),
    items: [],
    inflight: {},
    queue: [],
    queuePaused: false,
    permissions: {},
    plan: null,
    commands: [],
    models: isPlain(m.models) ? m.models : null,
    modes: isPlain(m.modes) ? m.modes : null,
    usage: { context: null, lastTurn: null, stats: null },
    lastError: null,
    turn: null, // rule 11: the prompt turn running, {reply, error}; null between turns
    loading: false, // between load-start and loaded: the updates replay the history
    seq: 0, // next item sequence number (row keys, permission anchors, chip ids)
    dropped: 0, // items dropped by the MAX_ITEMS cap since the last load
    unknown: 0, // session/update kinds this reducer does not know (rule 10)
  };
}

/** Whether a turn runs: any in-flight request not yet acknowledged (rule 6). A steer is acknowledged by
 *  its answer chunk; any other request by its response. */
export function isRunning(state) {
  return Object.values(isPlain(state?.inflight) ? state.inflight : {}).some((e) => !e.acked);
}

/** The chip the service sends next as a plain prompt: the queue head once no request is in flight and
 *  the queue is not paused (rule 6); otherwise null. */
export function queueHead(state) {
  if (!isPlain(state) || state.queuePaused || Object.keys(state.inflight).length > 0) return null;
  return state.queue[0] ?? null;
}

/** Whether an answer to a permission request may be sent now: `{ok: true, permission}`, or
 *  `{error: "not-found"}` (no such request, or `optionId` is not one it offers) or `{error: "too-late"}`
 *  (expired, already answered or cancelled; rule 4). */
export function canAnswer(state, requestId, now, optionId) {
  const p = isPlain(state?.permissions) ? state.permissions[String(requestId)] : null;
  if (!p) return { error: "not-found" };
  if (p.state !== "pending" || now >= p.deadline) return { error: "too-late" };
  if (optionId !== undefined && !p.options.some((o) => o.optionId === optionId)) return { error: "not-found" };
  return { ok: true, permission: p };
}

/** An approval card's options (D29): `buttons` are the agent's button option ids that are present, in
 *  the agent's order (Hermes: allow_once, allow_always, deny); `more` holds every other option in the
 *  order the agent sent them. Chosen by option id, never by kind. */
export function approvalButtons(options, agent = "hermes") {
  const list = Array.isArray(options) ? options.filter((o) => isPlain(o) && typeof o.optionId === "string") : [];
  const ids = agentOf(agent)?.buttonOptions ?? [];
  const buttons = [];
  for (const id of ids) {
    const o = list.find((x) => x.optionId === id);
    if (o) buttons.push(o);
  }
  return { buttons, more: list.filter((o) => !ids.includes(o.optionId)) };
}

// ---- items ------------------------------------------------------------------------------------------

/** The list with its last item no longer streaming. */
function settle(items) {
  const last = items[items.length - 1];
  if (!last || last.streaming !== true) return items;
  return [...items.slice(0, -1), { ...last, streaming: false }];
}

/** Rule 9: at most MAX_ITEMS items, the first being the `dropped` notice once anything was dropped. The
 *  notice's seq is -1, so no permission card is ever drawn after it. */
function cap(state, list) {
  if (list.length <= MAX_ITEMS) return { items: list, dropped: state.dropped };
  const body = list[0]?.dropNotice === true ? list.slice(1) : list;
  const cut = body.length - (MAX_ITEMS - 1);
  const dropped = state.dropped + cut;
  const notice = { type: "notice", code: "dropped", vars: { count: dropped }, seq: -1, dropNotice: true };
  return { items: [notice, ...body.slice(cut)], dropped };
}

/** Finished permission cards whose anchor item was dropped go with it. */
function prune(permissions, items) {
  const first = items.find((it) => it.dropNotice !== true);
  if (!first) return permissions;
  const out = {};
  for (const [k, p] of Object.entries(permissions)) {
    if (p.state !== "pending" && p.after !== null && p.after < first.seq) continue;
    out[k] = p;
  }
  return out;
}

/** Appends an item (ending the streaming one, rule 1), numbering it and applying the cap. */
function push(state, item) {
  const entry = { ...item, seq: state.seq };
  if (!state.loaded) entry.replayed = true;
  const { items, dropped } = cap(state, [...settle(state.items), entry]);
  const permissions = dropped !== state.dropped ? prune(state.permissions, items) : state.permissions;
  return { ...state, items, dropped, permissions, seq: state.seq + 1 };
}

const notice = (state, code, vars) => push(state, vars ? { type: "notice", code, vars } : { type: "notice", code });

function replaceAt(state, index, item) {
  const items = state.items.slice();
  items[index] = item;
  return { ...state, items };
}

function lastIndex(items, test) {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i])) return i;
  return -1;
}

// ---- tool content -----------------------------------------------------------------------------------

const textEntry = (t) => (t.length > MAX_TOOL_TEXT ? { type: "text", text: clip(t, MAX_TOOL_TEXT), truncated: true } : { type: "text", text: t });

/** ACP tool content → `[{type: "text", text} | {type: "diff", path, oldText, newText}]`; other kinds
 *  (terminal references, images) are left out. */
function toolContent(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const c of list) {
    if (!isPlain(c)) continue;
    if (c.type === "diff" && typeof c.path === "string") {
      out.push({ type: "diff", path: c.path, oldText: typeof c.oldText === "string" ? c.oldText : null, newText: str(c.newText) });
    } else if (c.type === "content" && isPlain(c.content) && c.content.type === "text" && typeof c.content.text === "string") {
      out.push(textEntry(c.content.text));
    }
  }
  return out;
}

function locations(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((l) => isPlain(l) && typeof l.path === "string").map((l) => ({ path: l.path, line: num(l.line) }));
}

const rawText = (v) => (typeof v === "string" ? clip(v, MAX_TOOL_TEXT) : v ?? null);

/** What a call started with, for the card's Input: its raw arguments when the agent sends them (Hermes:
 *  generic tools), otherwise the text of its first content (`$ ls`, a search, a todo list), or null. */
function inputOf(u, content) {
  if (u.rawInput !== undefined && u.rawInput !== null) return rawText(u.rawInput);
  const text = content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return text ? clip(text, MAX_TOOL_TEXT) : null;
}

/** Rule 11: the running turn got an answer (assistant text, a tool item, a permission); the history a load replays
 *  does not count. */
function replied(state) {
  return state.turn && !state.turn.reply && !state.loading ? { ...state, turn: { ...state.turn, reply: true } } : state;
}

function toolStart(state, u, now) {
  const id = str(u.toolCallId);
  if (!id) return state;
  if (lastIndex(state.items, (it) => it.type === "tool" && it.id === id) >= 0) return toolUpdate(state, u, now);
  const replayed = !state.loaded;
  const status = STATUSES.has(u.status) ? u.status : "pending";
  const content = toolContent(u.content);
  return push(replied(state), {
    type: "tool",
    id,
    title: str(u.title),
    kind: str(u.kind) || "other",
    status,
    startedAt: replayed ? null : now,
    endedAt: !replayed && ENDED.has(status) ? now : null,
    content,
    input: inputOf(u, content), // kept when updates replace `content` (rule 2)
    diff: null, // an edit approval's diff (rule 3), kept when updates replace `content`
    locations: locations(u.locations),
    rawOutput: rawText(u.rawOutput),
    replayed,
  });
}

/** Rule 2: the fields an update carries replace the item's; the end time is set once it ends. */
function toolUpdate(state, u, now) {
  const id = str(u.toolCallId);
  const at = lastIndex(state.items, (it) => it.type === "tool" && it.id === id);
  if (at < 0) return state;
  const next = { ...state.items[at] };
  if (typeof u.title === "string") next.title = u.title;
  if (typeof u.kind === "string") next.kind = u.kind;
  if (STATUSES.has(u.status)) next.status = u.status;
  if (has(u, "content")) next.content = toolContent(u.content);
  if (has(u, "locations")) next.locations = locations(u.locations);
  if (has(u, "rawInput") && u.rawInput !== null && u.rawInput !== undefined) next.input = rawText(u.rawInput);
  if (has(u, "rawOutput")) next.rawOutput = rawText(u.rawOutput);
  if (ENDED.has(next.status) && next.endedAt === null && !next.replayed) next.endedAt = now;
  return replaceAt(state, at, next);
}

// ---- messages ---------------------------------------------------------------------------------------

function textOf(content) {
  return isPlain(content) && content.type === "text" && typeof content.text === "string" ? content.text : "";
}

function oldestSteer(state) {
  for (const [id, e] of Object.entries(state.inflight)) if (e.kind === "steer" && !e.acked) return id;
  return null;
}

/** Rule 1 and rule 5: a chunk extends the last streaming item of its type; while a steer waits for its
 *  answer, an assistant chunk that is a steer reply becomes a notice and acknowledges the steer. Replayed
 *  chunks are whole messages and never stream. */
function chunk(state, type, content) {
  const text = textOf(content);
  if (!text) return state;
  if (type === "assistant") {
    const steer = oldestSteer(state);
    const reply = steer !== null ? steerReply(text, state.agent) : null;
    if (reply) {
      const inflight = { ...state.inflight, [steer]: { ...state.inflight[steer], acked: true } };
      return notice({ ...state, inflight }, reply.code, reply.vars);
    }
  }
  const base = type === "assistant" ? replied(state) : state;
  const items = base.items;
  const last = items[items.length - 1];
  if (base.loaded && last && last.type === type && last.streaming === true) {
    if (last.truncated) return base;
    const joined = last.text + text;
    const next = joined.length > MAX_MESSAGE ? { ...last, text: clip(joined, MAX_MESSAGE), truncated: true } : { ...last, text: joined };
    return replaceAt(base, items.length - 1, next);
  }
  const item = { type, text: clip(text, MAX_MESSAGE), streaming: base.loaded };
  if (text.length > MAX_MESSAGE) item.truncated = true;
  return push(base, item);
}

function userChunk(state, content) {
  const text = textOf(content);
  if (!text) return state;
  // Live, Hermes sends one only for a prompt it queued itself (server.py:1650).
  return push(state, { type: "user", text: clip(text, MAX_MESSAGE), attachments: [], via: state.loaded ? "queue" : "replay" });
}

// ---- update bodies ----------------------------------------------------------------------------------

function update(state, u, now) {
  if (!isPlain(u)) return state;
  switch (u.sessionUpdate) {
    case "agent_message_chunk":
      return chunk(state, "assistant", u.content);
    case "agent_thought_chunk":
      return chunk(state, "thought", u.content);
    case "user_message_chunk":
      return userChunk(state, u.content);
    case "tool_call":
      return toolStart(state, u, now);
    case "tool_call_update":
      return toolUpdate(state, u, now);
    case "plan": {
      const entries = Array.isArray(u.entries) ? u.entries.filter((e) => isPlain(e) && typeof e.content === "string") : [];
      return { ...state, plan: { entries: entries.map((e) => ({ content: e.content, priority: str(e.priority) || "medium", status: str(e.status) || "pending" })) } };
    }
    case "available_commands_update": {
      const list = Array.isArray(u.availableCommands) ? u.availableCommands.filter((c) => isPlain(c) && typeof c.name === "string") : [];
      return { ...state, commands: list.map((c) => ({ name: c.name, description: str(c.description), hint: isPlain(c.input) && typeof c.input.hint === "string" ? c.input.hint : null })) };
    }
    case "usage_update":
      return { ...state, usage: { ...state.usage, context: { size: num(u.size), used: num(u.used), cost: isPlain(u.cost) ? u.cost : null } } };
    case "current_mode_update":
      return typeof u.currentModeId === "string" ? { ...state, modes: { ...(state.modes ?? {}), currentModeId: u.currentModeId } } : state;
    case "session_info_update": {
      const next = { ...state };
      if (has(u, "title")) next.title = typeof u.title === "string" && u.title.trim() ? u.title : null;
      const at = typeof u.updatedAt === "string" ? Date.parse(u.updatedAt) : NaN;
      if (Number.isFinite(at)) next.updatedAt = at;
      return next;
    }
    case "config_option_update":
      return state; // known, and unused: Hermes advertises no config options
    default:
      return { ...state, unknown: state.unknown + 1 }; // rule 10
  }
}

// ---- permissions ------------------------------------------------------------------------------------

function options(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((o) => isPlain(o) && typeof o.optionId === "string").map((o) => ({ optionId: o.optionId, name: str(o.name) || o.optionId, kind: str(o.kind) }));
}

/** Rule 3: an edit approval's diff goes onto the newest live, unfinished `edit` tool item whose path
 *  (a location or a diff of its own) is the diff's path. */
function attachDiff(state, p) {
  const diff = p.content.find((c) => c.type === "diff");
  if (!diff) return state;
  const path = normalize(diff.path);
  const at = lastIndex(state.items, (it) => {
    if (it.type !== "tool" || it.kind !== "edit" || it.replayed || ENDED.has(it.status)) return false;
    const paths = [...it.locations.map((l) => l.path), ...it.content.filter((c) => c.type === "diff").map((c) => c.path)];
    return paths.some((x) => normalize(x) === path);
  });
  if (at < 0) return state;
  return replaceAt(state, at, { ...state.items[at], diff: { path: diff.path, oldText: diff.oldText, newText: diff.newText } });
}

function permission(state, e, now) {
  if (e.requestId === undefined || e.requestId === null) return state;
  const key = String(e.requestId);
  const tc = isPlain(e.toolCall) ? e.toolCall : {};
  const at = num(e.at) ?? now;
  const last = state.items[state.items.length - 1];
  const p = {
    requestId: e.requestId,
    toolCallId: str(tc.toolCallId),
    title: str(tc.title),
    kind: str(tc.kind) || "other",
    content: toolContent(tc.content),
    options: options(e.options),
    at,
    deadline: at + PERMISSION_TIMEOUT_MS, // rule 4
    state: "pending",
    optionId: null, // the answer, once answered
    after: last ? last.seq : null, // drawn after this item
  };
  const next = { ...replied(state), permissions: { ...state.permissions, [key]: p } };
  return p.toolCallId.startsWith(EDIT_APPROVAL) ? attachDiff(next, p) : next;
}

function answered(state, e, now) {
  const key = String(e.requestId);
  const p = state.permissions[key];
  if (!p || p.state === "answered") return state;
  const set = (q) => ({ ...state, permissions: { ...state.permissions, [key]: q } });
  const pick = typeof e.optionId === "string" ? e.optionId : null;
  if (p.state === "pending" && now < p.deadline) return set(pick ? { ...p, state: "answered", optionId: pick } : { ...p, state: "cancelled" });
  const closed = p.state === "pending" ? set({ ...p, state: "expired" }) : state;
  // Rule 4: an answer after expiry (or after the turn ended) is refused; a cancel by lazuli says nothing.
  return pick ? notice(closed, "too-late") : closed;
}

function expire(state, now) {
  let changed = false;
  const out = {};
  for (const [k, p] of Object.entries(state.permissions)) {
    if (p.state === "pending" && now >= p.deadline) {
      out[k] = { ...p, state: "expired" };
      changed = true;
    } else out[k] = p;
  }
  return changed ? { ...state, permissions: out } : state;
}

// ---- prompts and the queue --------------------------------------------------------------------------

/** A request sent. One already in flight, or sent `again`, only gets its user item (a running turn applied again after
 *  its history loaded). A prompt sent while nothing runs starts a turn (rule 11); a steer or command does not. */
function sent(state, e, now) {
  if (e.requestId === undefined || e.requestId === null) return state;
  const id = String(e.requestId);
  const kind = KINDS.has(e.kind) ? e.kind : "prompt";
  let next = state;
  if (!has(state.inflight, id) && e.again !== true) {
    const turn = isRunning(state) ? state.turn : kind === "prompt" ? { reply: false, error: null } : null;
    next = { ...state, inflight: { ...state.inflight, [id]: { kind, at: now, acked: false } }, turn };
    if (kind !== "steer") next.lastError = null;
  }
  const text = str(e.text);
  const attachments = Array.isArray(e.attachments) ? e.attachments : [];
  if (text || attachments.length) {
    const via = VIAS.has(e.via) ? e.via : kind === "steer" ? "steer" : "prompt";
    next = push(next, { type: "user", text: clip(text, MAX_MESSAGE), attachments, via, requestId: id });
  }
  return next;
}

/** An approval still open when its turn ends this close to its deadline (or after it) was given up by the agent at its
 *  own 60 s timeout (Hermes, permissions.py:111; the fake agent cancels it): it reads as expired, not cancelled, so a
 *  late answer is refused as too late (rule 4). The agent's clock starts a moment before the bridge's receive time. */
export const EXPIRY_GRACE_MS = 2000;

/** After a request ends: once nothing runs, the turn ends (rule 11), streaming ends and open approval cards close:
 *  expired when their deadline is (nearly) reached, else cancelled. */
function settleTurn(state, now) {
  if (isRunning(state)) return state;
  let permissions = state.permissions;
  for (const [k, p] of Object.entries(permissions)) {
    if (p.state !== "pending") continue;
    const gone = typeof now === "number" && now >= p.deadline - EXPIRY_GRACE_MS ? "expired" : "cancelled";
    permissions = { ...permissions, [k]: { ...p, state: gone } };
  }
  return { ...state, items: settle(state.items), permissions, turn: null };
}

function done(state, e, now) {
  const id = String(e.requestId);
  if (!has(state.inflight, id)) return state;
  const inflight = { ...state.inflight };
  delete inflight[id];
  let next = { ...state, inflight };
  if (isPlain(e.usage)) next.usage = { ...next.usage, lastTurn: e.usage };
  if (e.stopReason === "cancelled") next = notice(next, "cancelled");
  else if (typeof e.stopReason === "string" && e.stopReason !== "end_turn") next = notice(next, "stopped", { detail: e.stopReason });
  else if (next.turn && !next.turn.reply && !isRunning(next)) {
    // Rule 11: the turn ended without a word from the agent.
    const detail = next.turn.error ?? NO_REPLY;
    const item = { type: "notice", code: "failed", vars: { detail } };
    if (!next.turn.error) item.noReply = now; // when, for an error line that comes just after
    next = push({ ...next, lastError: { code: null, message: detail } }, item);
  }
  return settleTurn(next, now);
}

/** An error line that comes this long after a reply-less turn ended still fills in its notice's detail. */
const LATE_ERROR_MS = 5000;

/** An agent error line: kept as the running turn's newest (rule 11); between turns, just after a reply-less turn, it
 *  fills in the NO_REPLY detail of that turn's notice when it is the last item. */
function agentError(state, e, now) {
  const text = clip(str(e.text).trim(), MAX_ERROR);
  if (!text) return state;
  if (state.turn) return state.turn.error === text ? state : { ...state, turn: { ...state.turn, error: text } };
  const at = state.items.length - 1;
  const last = state.items[at];
  if (!last || last.type !== "notice" || typeof last.noReply !== "number" || now - last.noReply > LATE_ERROR_MS) return state;
  const filled = { ...last, vars: { detail: text } };
  delete filled.noReply;
  return { ...replaceAt(state, at, filled), lastError: { code: null, message: text } };
}

function failed(state, e, now) {
  const id = String(e.requestId);
  const err = e.error;
  const message = typeof err === "string" ? err : isPlain(err) ? str(err.message) : "";
  const code = isPlain(err) && (typeof err.code === "number" || typeof err.code === "string") ? err.code : null;
  const inflight = { ...state.inflight };
  delete inflight[id];
  const next = { ...state, inflight, lastError: { code, message } };
  return settleTurn(notice(next, "failed", { detail: code === null ? message : `${message} (${code})` }), now);
}

function queued(state, e, now) {
  const text = str(e.text);
  if (!text.trim()) return state;
  const id = typeof e.chipId === "string" && e.chipId ? e.chipId : `chip-${state.seq}`;
  if (state.queue.some((c) => c.id === id)) return state;
  return { ...state, queue: [...state.queue, { id, text: clip(text, MAX_MESSAGE), at: now }], seq: state.seq + 1 };
}

function flush(state, e, now) {
  const chip = typeof e.chipId === "string" ? state.queue.find((c) => c.id === e.chipId) : state.queue[0];
  if (!chip || e.requestId === undefined || e.requestId === null) return state;
  const next = { ...state, queue: state.queue.filter((c) => c !== chip) };
  return sent(next, { requestId: e.requestId, kind: "prompt", text: chip.text, via: "queue" }, now);
}

// ---- reducer ----------------------------------------------------------------------------------------

/** The next state for one event at time `now` (ms). */
export function reduce(state, event, now) {
  if (!isPlain(state) || !isPlain(event)) return state;
  const t = num(now) ?? 0;
  switch (event.type) {
    case "update":
      return update(state, event.update, t);
    case "permission":
      return permission(state, event, t);
    case "permission-answered":
      return answered(state, event, t);
    case "prompt-sent":
      return sent(state, event, t);
    case "prompt-done":
      return done(state, event, t);
    case "prompt-failed":
      return failed(state, event, t);
    case "queued":
      return queued(state, event, t);
    case "unqueued":
      return state.queue.some((c) => c.id === event.chipId) ? { ...state, queue: state.queue.filter((c) => c.id !== event.chipId) } : state;
    case "queue-paused":
      return state.queuePaused ? state : { ...state, queuePaused: true };
    case "queue-resumed":
      return state.queuePaused ? { ...state, queuePaused: false } : state;
    case "queue-flush":
      return flush(state, event, t);
    case "load-start": {
      // Rule 7. Finished cards belonged to the transcript being replaced; open ones stay, unanchored.
      const permissions = {};
      for (const [k, p] of Object.entries(state.permissions)) if (p.state === "pending") permissions[k] = { ...p, after: null };
      return { ...state, items: [], plan: null, loaded: false, loading: true, dropped: 0, permissions };
    }
    case "loaded":
      return {
        ...state,
        loaded: true,
        loading: false,
        stale: false,
        items: settle(state.items),
        models: has(event, "models") ? (isPlain(event.models) ? event.models : null) : state.models,
        modes: has(event, "modes") ? (isPlain(event.modes) ? event.modes : null) : state.modes,
      };
    case "agent-error":
      return agentError(state, event, t);
    case "model-set": {
      if (typeof event.modelId !== "string" || !event.modelId) return state;
      const models = isPlain(state.models) ? { ...state.models, currentModelId: event.modelId } : { availableModels: [], currentModelId: event.modelId };
      const found = Array.isArray(models.availableModels) ? models.availableModels.find((m) => m?.modelId === event.modelId) : null;
      return notice({ ...state, models }, "model-set", { model: str(found?.name) || event.modelId });
    }
    case "stats":
      return { ...state, usage: { ...state.usage, stats: isPlain(event.stats) ? event.stats : null } };
    case "gap": // rule 8; the one notice says the chat reloads once idle
      return state.stale ? { ...state, items: settle(state.items) } : notice({ ...state, stale: true }, "gap");
    case "disconnected": // rule 8; the bridge state tells why
      return { ...state, stale: true, items: settle(state.items) };
    case "tick":
      return expire(state, t);
    case "notice":
      return typeof event.code === "string" && event.code ? notice(state, event.code, isPlain(event.vars) ? event.vars : undefined) : state;
    default:
      return state;
  }
}

// ---- rows -------------------------------------------------------------------------------------------

/** The transcript as drawn: items in order, each permission card after the item that was last when it
 *  arrived (cards without one at the end, oldest first). Tool rows carry `duration` (ms; null while
 *  running and for replayed items, rule 2); steer rows carry `sending` until acknowledged; permission rows
 *  carry `edit`, `buttons` and `more` (D29). */
export function rows(state) {
  if (!isPlain(state) || !Array.isArray(state.items)) return [];
  const steering = new Set(Object.entries(state.inflight).filter(([, e]) => e.kind === "steer" && !e.acked).map(([id]) => id));
  const present = new Set(state.items.map((it) => it.seq));
  const anchored = new Map();
  const loose = [];
  const cards = Object.values(state.permissions).sort((a, b) => a.at - b.at);
  for (const p of cards) {
    const { buttons, more } = approvalButtons(p.options, state.agent);
    const row = { type: "permission", ...p, edit: p.toolCallId.startsWith(EDIT_APPROVAL), buttons, more };
    if (p.after !== null && present.has(p.after)) {
      if (!anchored.has(p.after)) anchored.set(p.after, []);
      anchored.get(p.after).push(row);
    } else loose.push(row);
  }
  const out = [];
  for (const it of state.items) {
    if (it.type === "tool") {
      const timed = !it.replayed && typeof it.startedAt === "number" && typeof it.endedAt === "number";
      out.push({ ...it, duration: timed ? it.endedAt - it.startedAt : null });
    } else if (it.type === "user" && it.via === "steer") out.push({ ...it, sending: steering.has(it.requestId) });
    else out.push(it);
    const after = anchored.get(it.seq);
    if (after) out.push(...after);
  }
  out.push(...loose);
  return out;
}
