// The Assistant service (CONTRACTS K4; K2, K3, K5–K7; D3, D12, D22, D25, D28–D30): one module state shared by every
// lazuli copy, run by the always-shown `status` copy (views/shell/services.js starts it) and acted on by the Assistant
// views through the calls below. Views call them inside `cx.spawn` and read `snapshot()` in render.
//
//   start(cx); stop()                        start reconnects to running bridges of this folder and Herdr (no
//                                            launch, no hermes command); stop closes sockets, bridges keep running
//   snapshot(): AssistantState; session(key): ChatState | null           key = `${profile}/${sessionId}`
//   open(cx); recheck(cx); refreshList(cx, profile?)
//   pickFolder(cx); setFolder(cx, path, {confirmed})
//   newSession(cx, profile); select(cx, key); fork(cx, key)
//   send(cx, key, {text, attachments})       idle: session/prompt; running: "/steer <text>"
//   queue(cx, key, text); unqueue(key, chipId); resumeQueue(cx, key)      lazuli-held chips (D28)
//   stopTurn(cx, key); answerPermission(cx, key, requestId, optionId); setModel(cx, key, modelId)
//   toggleGroup(profile); retryBridge(cx, profile); folderFiles(): string[]
//   openTarget(cx, profile, sessionId)       a notification's click (`lazuli.target:assistant:<p>:<s>`)
//   onNotice(fn)                             notices for sys/notify.js: {id, kind, key, title, body, at}
//
// Results are `{ok: true, …}` or `{error}`, codes: no-folder relay hermes-missing hermes-check-failed
// bridge-launch-failed bridge-timeout agent-exit auth disconnected busy not-found too-long too-late rpc:<code>, and
// `cancelled` for a dismissed folder picker.
//
// Each chat is core/assistant-chat.js state, reduced from the bridge's records and the service's own events; the list
// is core/assistant-list.js `buildList` over each profile's state.db rows (sys/assistant-sessions.js), the sessions
// made in this run, the running set, the shared key `lazuli.assistant.ui` and the Hermes local sessions this service
// made (`lazuli.assistant.owned`, by profile and folder: the only local chats listed and restored). Changes redraw
// every copy through the store `assistant` (no snapshot: nothing of the Assistant reaches the relay, D5), at most once
// per 80 ms.
//
// Every `net`, `exec` and `hc` call is behind `checking()`: `herdr-app check` runs no part of this.

import { checking, exec, home, shared, setShared, pickFolder as pickFolderDialog, window as appWindow } from "herdr";
import { t } from "../core/i18n.js";
import * as wire from "../core/acp-wire.js";
import { emptyChat, reduce, isRunning, queueHead, canAnswer, MAX_MESSAGE } from "../core/assistant-chat.js";
import {
  buildList, normalizeUi, pruneUi, mapSessionList, parseKey, sessionKey, isProfileName, isSessionId, pathsToResolve,
  isLocalSessionId, normalizeOwned, addOwned, ownedIds, dropOwned, heldSelection,
} from "../core/assistant-list.js";
import { agentArgv, routeText } from "../core/assistant-agents.js";
import { normalize } from "../core/paths.js";
import * as store from "./store.js";
import { KEY } from "./state.js";
import { showCenter } from "./bus.js";
import { blockShown } from "../views/panels/common.js";
import { AcpClient, shutdownBridge } from "./acp-client.js";
import * as bridge from "./assistant-bridge.js";
import * as disk from "./assistant-sessions.js";

/** The store that redraws the copies; never snapshotted (D5). */
export const ASSISTANT_STORE = "assistant";
/** The layout block of the Assistant screen (K2). */
const SCREEN = "assistant";
const FLUSH_MS = 80;
const TICK_MS = 1000;
const REAP_EVERY = 60;
const FILES_EVERY = 10;
const LIST_EVERY = 30;
const LIST_AFTER_TURN_MS = 1200;
const NEW_MS = 60000;
/** A `session/load` without an answer by then counts as lost: the stream reopens and the load tries once more. */
const LOAD_MS = 45000;
const LIST_MS = 30000;
/** A stream whose read loop handled no line for this long (the bridge pings after 10 s of silence) has stopped: the
 *  service reopens it from the last record held. */
const STALL_MS = 30000;
const NOTICES_KEPT = 20;
const BODY_MAX = 300;
/** A running turn's events kept for a load mid-turn (as many as the bridge's ring holds records). */
const TURN_LOG_MAX = 4000;

const log = (msg) => {
  console.log(`[lazuli/assistant] ${msg}`);
  store.debugLog("assistant", msg);
};
const errText = (e) => e?.message ?? String(e);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const run = (command, args, options) => exec(command, args, options);

// ---- state ------------------------------------------------------------------------------------------------------

function fresh(folder = null) {
  return {
    gate: "checking",
    gateDetail: null,
    folder,
    hermes: null, // {path, version}
    bridges: {}, // profile → {state, error?, detail?}
    sessions: {}, // key → ChatState
    notices: [],
    profiles: [], // [{profile, rows, error?}] for buildList
    local: [], // sessions made this run: [{profile, sessionId, title, updatedAt, cwd}]
    files: [], // the folder's files for the @ menu
  };
}

const S = fresh();
/** Bumped by every change; snapshot() is rebuilt only when it moved. */
let version = 0;
let built = { version: -1, value: null };
let flushing = false;
let service = null; // {stopped} while started
let checked = null; // {key, promise} of this start's agent check
let hermesBin = null; // the hermes program this start checked or looked up (never debugAgent's): the bridges' argv
const clients = new Map(); // profile → last scoped AcpClient (also retained during stream recovery for shutdown)
const launches = new Map(); // profile → {promise, launch}: the connect (or reopen) in flight, and whether it may launch
const pendingStops = new Map(); // profile → discovery whose shutdown is unconfirmed (older bridges may unlink early)
const releasedStreams = new Map(); // profile/folder → { token, pid } relinquished to a successor
const releaseKey = (profile, folder) => `${profile}/${folder}`;
const loads = new Map(); // key → Promise of a session/load
const promptKeys = new Map(); // request id → {key, kind, resync}
const listeners = new Set();
let opening = null;
let listing = null;
let switching = null;
let folderGeneration = 0;
const folderScope = () => ({ folder: S.folder, generation: folderGeneration });
const scopeActive = (scope) => !switching && scope.generation === folderGeneration && scope.folder === S.folder;
const clientCurrent = (profile, client) => Boolean(client && clients.get(profile) === client
  && scopeActive(client.scope) && client.d.profile === profile && client.d.cwd === client.scope.folder);
function activeClient(profile) {
  const client = clients.get(profile);
  return client?.open && clientCurrent(profile, client) ? client : null;
}
let filesAt = 0;
let filesBusy = false; // a walk of the folder's files runs
let filesAgain = false; // a forced refresh came while it ran: one more walk after it
const listSoon = new Set();
// Where each folder of the list really is (symlinks and macOS firmlinks resolved, once per distinct path): a session
// made in `/tmp/x` belongs to a folder picked as `/private/tmp/x` and the other way round (core/assistant-list.js).
const real = {};
// The turn running in each chat, as events to apply again after its history loads: Hermes saves a turn only when it
// ends, so a load mid-turn (a reload, a selection) replays the history without it. The prompts sent, then every update
// the turn streamed (a steer's answer as its notice). Null once the turn outgrew TURN_LOG_MAX: the chat then reloads
// once idle.
const turns = new Map(); // key → events | null
const loadingKeys = new Set(); // chats whose session/load is open: their updates replay the history
const endedInLoad = new Set(); // chats whose turn ended while their history loaded: they load once more
// Hermes gateway chats (a local id) whose load waits for their running turn's answer (reload): they load once idle.
const deferredLoads = new Set();
const seen = new Map(); // profile → {pid, seq}: the newest record applied from that bridge (a replay of it is dropped)
const resume = new Map(); // profile → {pid, seq}: where the last stream of that bridge stopped, for the next one
let clientSeq = 0;
const NONCE = `l${Date.now().toString(36)}`;

const debugAgent = () => store.settings().assistant?.debugAgent ?? null;
const settingsFolder = () => store.settings().assistant?.folder ?? null;

/** Marks a change: copies redraw within FLUSH_MS (one `store.set` per window). */
function changed(cx) {
  version++;
  if (flushing || !cx) return;
  flushing = true;
  try {
    cx.spawn(
      async (tcx) => {
        await tcx.sleep(FLUSH_MS);
        flushing = false;
        store.set(ASSISTANT_STORE, { version, at: Date.now() }, { snapshot: false });
      },
      { owner: null },
    );
  } catch (e) {
    flushing = false;
    log(`redraw not scheduled: ${errText(e)}`);
  }
}

/** Runs `fn(cx)` in a task no view owns (it outlives the copy that asked) and resolves with its result. */
function owned(cx, fn) {
  return new Promise((resolve) => {
    cx.spawn(
      async (tcx) => {
        try {
          resolve(await fn(tcx));
        } catch (e) {
          log(`failed: ${errText(e)}`);
          resolve({ error: "disconnected", detail: errText(e) });
        }
      },
      { owner: null },
    );
  });
}

const gateError = () => (S.gate === "no-folder" || S.gate === "folder-missing" ? "no-folder" : S.gate === "ok" || S.gate === "checking" ? "disconnected" : S.gate);

function uiNow() {
  return normalizeUi(shared(KEY.assistantUi), S.folder);
}

function setUi(cx, next) {
  if (!S.folder) return;
  setShared(KEY.assistantUi, next);
  changed(cx);
}

function selectedKey() {
  const s = uiNow().selected;
  return s ? `${s.profile}/${s.session}` : null;
}

function ownedNow() {
  return normalizeOwned(shared(KEY.assistantOwned));
}

/** Remembers a Hermes local session this service made (`session/new`, `session/fork`) with the profile and folder of
 *  the bridge that answered, so the list shows it and a reload restores it. Other ids need no record: Hermes lists
 *  them itself (SESSIONS_SQL). */
function own(cx, scope, profile, sessionId) {
  if (!isLocalSessionId(sessionId) || !scopeActive(scope) || !scope.folder) return;
  const next = addOwned(shared(KEY.assistantOwned), { profile, folder: scope.folder, session: sessionId, at: Date.now() });
  if (!next) return;
  setShared(KEY.assistantOwned, next);
  changed(cx);
}

function setBridge(cx, profile, value) {
  S.bridges = { ...S.bridges, [profile]: value };
  changed(cx);
}

function setGate(cx, gate, detail = null) {
  if (S.gate === gate && S.gateDetail === detail) return;
  S.gate = gate;
  S.gateDetail = detail;
  changed(cx);
}

function ensureChat(key, meta = {}) {
  if (!S.sessions[key]) {
    const k = parseKey(key);
    S.sessions[key] = emptyChat(key, { profile: k?.profile, sessionId: k?.sessionId, agent: "hermes", ...meta });
  }
  return S.sessions[key];
}

/** Reduces events into a chat (the same state object when nothing changed). A turn's log goes once the turn ended
 *  (unless its history is loading: the turn is then checked after the load). */
function apply(cx, key, ...events) {
  let c = S.sessions[key];
  if (!c) return null;
  const now = Date.now();
  for (const e of events) c = reduce(c, e, now);
  if (c !== S.sessions[key]) {
    S.sessions[key] = c;
    changed(cx);
  }
  if (turns.has(key) && !loadingKeys.has(key) && !isRunning(c)) turns.delete(key);
  return c;
}

/** Adds an event to a chat's turn log, before it is applied: a prompt sent while nothing runs starts a new log. */
function logTurn(key, event) {
  if (event.type === "prompt-sent" && (!turns.has(key) || !isRunning(S.sessions[key]))) {
    turns.set(key, [event]);
    return;
  }
  const events = turns.get(key);
  if (!events) return;
  if (events.length >= TURN_LOG_MAX) turns.set(key, null);
  else events.push(event);
}

/** After a load: the turn still running there, applied again after the history (its prompts only add their user
 *  items). A turn too long to keep marks the chat stale instead: it reloads once idle (K5 rule 8). */
function resumeTurn(cx, key) {
  if (!turns.has(key)) return;
  if (!isRunning(S.sessions[key])) {
    turns.delete(key);
    return;
  }
  const events = turns.get(key);
  if (events === null) apply(cx, key, { type: "gap" });
  else apply(cx, key, ...events.map((e) => (e.type === "prompt-sent" ? { ...e, again: true } : e)));
}

/** Notes a record's seq from a bridge; false when it was applied already (a stream asked for it again). */
function firstSight(profile, pid, seq) {
  if (!Number.isInteger(seq)) return true;
  const s = seen.get(profile);
  if (s && s.pid === pid && seq <= s.seq) return false;
  seen.set(profile, { pid, seq });
  return true;
}

// Titles (row and header): the agent's title (a `session_info_update` this run, else the list row's: Hermes's database
// or `session/list`), and only while there is none a new session's first prompt line (`local.prompt`). The header
// takes it when the chat has no title yet or only one fillTitle put there; a title the agent sent stays.
const agentTitles = new Map(); // key → the title the agent last sent this run
const filledTitles = new Map(); // key → the title fillTitle put into that chat

const storedOf = (key) => {
  const k = parseKey(key);
  return k ? (S.profiles.find((p) => p.profile === k.profile)?.rows ?? []).find((r) => r.id === k.sessionId) ?? null : null;
};
const localOf = (key) => S.local.find((l) => `${l.profile}/${l.sessionId}` === key) ?? null;

/** The remembered selection standing in for its row (core/assistant-list.js heldSelection): a Hermes local session
 *  this service made with that profile in this folder that nothing of this run holds (after a reload; its database row
 *  may count no message yet). A list entry like a session made in this run, but not one of S.local: "+" never reuses
 *  it, and it goes once another chat is selected. */
function heldLocal() {
  const h = S.folder ? heldSelection(shared(KEY.assistantUi), shared(KEY.assistantOwned), S.folder) : null;
  if (!h || localOf(`${h.profile}/${h.sessionId}`)) return null;
  return { profile: h.profile, sessionId: h.sessionId, title: null, prompt: null, updatedAt: h.at, cwd: S.folder };
}
const heldOf = (key) => {
  const h = heldLocal();
  return h && `${h.profile}/${h.sessionId}` === key ? h : null;
};
const titleText = (s) => (typeof s === "string" && s.trim() ? s : null);

/** A session's title as the list shows it (null: none known). */
function listTitle(key) {
  const l = localOf(key);
  return titleText(agentTitles.get(key)) ?? titleText(storedOf(key)?.title) ?? titleText(l?.title) ?? titleText(l?.prompt);
}

/** The header's title, as the list shows it: into a chat with no title yet (a load sends none) or with the one this
 *  function put there, so a first-prompt stand-in gives way to the agent's title. */
function fillTitle(cx, key) {
  const chat = S.sessions[key];
  const title = listTitle(key);
  if (!chat || !title || chat.title === title) return;
  if (chat.title && chat.title !== filledTitles.get(key)) return;
  filledTitles.set(key, title);
  apply(cx, key, { type: "update", update: { sessionUpdate: "session_info_update", title } });
}

/** The list's sources with the titles as listTitle gives them: the agent's newest over a stored row's, a local
 *  session's first prompt only while it has no other. */
function listSources() {
  const profiles = agentTitles.size
    ? S.profiles.map((p) => {
        if (!Array.isArray(p.rows) || !p.rows.some((r) => agentTitles.has(`${p.profile}/${r.id}`))) return p;
        return { ...p, rows: p.rows.map((r) => (titleText(agentTitles.get(`${p.profile}/${r.id}`)) ? { ...r, title: agentTitles.get(`${p.profile}/${r.id}`) } : r)) };
      })
    : S.profiles;
  const held = heldLocal();
  const local = (held ? [...S.local, held] : S.local).map((l) => {
    const title = listTitle(`${l.profile}/${l.sessionId}`);
    return title === l.title ? l : { ...l, title };
  });
  return { profiles, local };
}

const chatsOf = (profile) => Object.values(S.sessions).filter((c) => c.profile === profile);

// ---- the API: reading -------------------------------------------------------------------------------------------

/** The whole state (K4 AssistantState): `{gate, gateDetail, folder, hermes, bridges, list, sessions, notices}`. The
 *  same object until something changes. Safe in render(). */
export function snapshot() {
  if (built.version === version && built.value) return built.value;
  const running = Object.values(S.sessions)
    .filter((c) => isRunning(c))
    .map((c) => c.key);
  const list = buildList({ folder: S.folder, home: home(), ...listSources(), running, bridges: S.bridges, ui: uiNow(), owned: ownedNow(), real });
  const value = { gate: S.gate, gateDetail: S.gateDetail, folder: S.folder, hermes: S.hermes, bridges: S.bridges, list, sessions: S.sessions, notices: S.notices };
  built = { version, value };
  return value;
}

/** One session's ChatState, or null. */
export const session = (key) => S.sessions[key] ?? null;

/** The folder's files for the @ menu: folder-relative paths, images left out. Kept fresh by the service. */
export const folderFiles = () => S.files;

/** Calls `fn(notice)` for each notice raised (`{id, kind: permission|done|failed, key, title, body, at}`). Returns a
 *  function that stops it. */
export function onNotice(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// ---- notices ----------------------------------------------------------------------------------------------------

function rowOf(key) {
  return storedOf(key) ?? localOf(key) ?? heldOf(key);
}

function titleOf(key) {
  const c = S.sessions[key];
  const first = c?.items?.find((it) => it.type === "user" && it.text)?.text;
  return c?.title || listTitle(key) || (first ? first.split("\n")[0].slice(0, 60) : "") || t("assistant.list.untitled");
}

const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, BODY_MAX);

/** A notice for the person (K7), unless they are looking at that session in the active window. */
function raise(cx, kind, key, body) {
  if (blockShown(SCREEN) && appWindow().active && selectedKey() === key) return;
  const now = Date.now();
  const n = { id: `${kind}:${key}:${now}`, kind, key, title: titleOf(key), body: oneLine(body), at: now };
  S.notices = [...S.notices.slice(-(NOTICES_KEPT - 1)), n];
  changed(cx);
  for (const fn of [...listeners]) {
    try {
      fn(n);
    } catch (e) {
      log(`notice listener failed: ${errText(e)}`);
    }
  }
}

function lastAnswer(key) {
  const items = S.sessions[key]?.items ?? [];
  for (let i = items.length - 1; i >= 0; i--) if (items[i].type === "assistant" && items[i].text) return items[i].text;
  return "";
}

// ---- records from the bridges -----------------------------------------------------------------------------------

function onRecord(cx, profile, client, rec) {
  if (!firstSight(profile, client.pid, rec.seq)) return;
  const c = rec.c;
  if (c.kind === "update") {
    const key = c.sessionId ? sessionKey(profile, c.sessionId) : null;
    if (!key) return;
    const before = ensureChat(key);
    const event = { type: "update", update: c.update };
    const after = apply(cx, key, event);
    // A running turn's update is kept for a load mid-turn; one its history replays (load open) is not.
    if (turns.has(key) && !loadingKeys.has(key)) logTurn(key, steerNotice(before, after) ?? event);
    if (c.updateKind === "session_info_update" && Object.prototype.hasOwnProperty.call(c.update ?? {}, "title")) {
      // The agent's title: the row and the header show it over a first-prompt stand-in.
      if (titleText(c.update.title)) agentTitles.set(key, c.update.title);
      else agentTitles.delete(key);
      const local = localOf(key);
      if (local) local.title = titleText(c.update.title);
      changed(cx);
    }
    return;
  }
  if (c.kind === "request") {
    if (c.method === wire.METHOD.requestPermission && c.sessionId) {
      const key = sessionKey(profile, c.sessionId);
      if (!key) return;
      ensureChat(key);
      apply(cx, key, { type: "permission", requestId: c.id, toolCall: c.params?.toolCall, options: c.params?.options, at: rec.at ?? Date.now() });
      raise(cx, "permission", key, c.params?.toolCall?.title ?? "");
      return;
    }
    // fs and terminal are off (K3): nothing else is asked of lazuli.
    client.send(cx, wire.rpcError(c.id, -32601, "Method not found")).then(undefined, () => {});
    return;
  }
  if (c.kind === "result" || c.kind === "error") onAnswer(cx, String(c.id), c);
}

/** A chunk that acknowledged a steer became a notice (K5 rule 5): the turn log keeps that notice, since applied again
 *  later the chunk would find no steer waiting. */
function steerNotice(before, after) {
  const last = after?.items?.[after.items.length - 1];
  if (!last || last.type !== "notice" || !String(last.code).startsWith("steer-")) return null;
  if (before?.items?.[before.items.length - 1]?.seq === last.seq) return null;
  return last.vars ? { type: "notice", code: last.code, vars: last.vars } : { type: "notice", code: last.code };
}

function onAnswer(cx, id, c) {
  const entry = promptKeys.get(id);
  if (!entry) return;
  promptKeys.delete(id);
  const { key, kind } = entry;
  if (!S.sessions[key]) return;
  if (c.kind === "result") {
    const stopReason = typeof c.result?.stopReason === "string" ? c.result.stopReason : "end_turn";
    const after = apply(cx, key, { type: "prompt-done", requestId: id, stopReason, ...(isObj(c.result?.usage) ? { usage: c.result.usage } : {}) });
    // The turn's own outcome: lastError is set once nothing runs only when this turn failed (K5 rule 11); an earlier
    // request's failure inside it (a refused steer) is cleared when the turn ends otherwise.
    if (kind === "prompt" && stopReason !== "cancelled") {
      if (after?.lastError && !isRunning(after)) raise(cx, "failed", key, after.lastError.message);
      else raise(cx, "done", key, lastAnswer(key));
    }
  } else {
    apply(cx, key, { type: "prompt-failed", requestId: id, error: c.error });
    raise(cx, "failed", key, c.error?.message ?? "");
  }
  if (loadingKeys.has(key) && !isRunning(S.sessions[key])) endedInLoad.add(key);
  afterTurn(cx, key, entry);
}

/** After a request ends: a command that rewrote the history (`resync`) reloads the session first, then the rest runs
 *  on the history it loaded; the queue head goes (K5 rule 6), a stale chat reloads once idle, as does a gateway chat
 *  whose load waited for this answer (reload), and the list is read again (message counts, titles, cost). */
function afterTurn(cx, key, entry) {
  const chat = S.sessions[key];
  if (!chat) return;
  if (entry?.resync && !isRunning(chat)) {
    const scope = folderScope();
    reload(cx, key).then(() => {
      if (scopeActive(scope)) nextTurn(cx, key, { reloaded: true });
    });
    return;
  }
  nextTurn(cx, key, { reloaded: false });
}

/** afterTurn once the chat is settled: the queue head, a load still owed (not after one just made), the list, files. */
function nextTurn(cx, key, { reloaded }) {
  if (!S.sessions[key]) return;
  flushQueue(cx, key);
  const after = S.sessions[key];
  if (!reloaded && !isRunning(after) && (deferredLoads.has(key) || (after?.stale && selectedKey() === key))) reload(cx, key);
  if (!isRunning(after)) scheduleList(cx, after.profile);
  refreshFiles(cx);
}

function onEvent(cx, profile, client, ev) {
  if (!firstSight(profile, client.pid, ev.seq)) return;
  if (ev.ev === "gap") {
    for (const c of chatsOf(profile)) {
      apply(cx, c.key, { type: "gap" });
      if (selectedKey() === c.key && !isRunning(S.sessions[c.key])) reload(cx, c.key);
    }
  } else if (ev.ev === "agent-error") {
    // Not tied to a session: each chat of the profile keeps it for its running turn (K5 rule 11).
    if (typeof ev.text === "string") for (const c of chatsOf(profile)) apply(cx, c.key, { type: "agent-error", text: ev.text });
  } else if (ev.ev === "dropped") {
    log(`${profile}: the bridge dropped an agent line of ${ev.bytes} bytes`);
  }
}

/** A profile's bridge is gone (or left): its chats' requests fail and the chats turn stale (they load again with the
 *  next bridge). */
function failChats(cx, profile, code) {
  for (const chat of chatsOf(profile)) {
    const open = Object.keys(chat.inflight ?? {});
    for (const id of open) {
      promptKeys.delete(id);
      apply(cx, chat.key, { type: "prompt-failed", requestId: id, error: code });
    }
    apply(cx, chat.key, { type: "disconnected" });
    if (open.length) raise(cx, "failed", chat.key, t(`assistant.banner.${code}`));
  }
}

/** The stream of a profile's bridge ended. A drop with the bridge still running reconnects and replays what was
 *  missed; otherwise the bridge is gone: its chats' requests fail, the chats turn stale and the group shows why. */
async function onEnd(cx, profile, client, why) {
  if (!clientCurrent(profile, client)) return;
  if (Number.isInteger(client.seq)) resume.set(profile, { pid: client.pid, seq: client.seq });
  log(`${profile} stream ended: ${why.reason}${why.bye ? ` (bye ${why.bye})` : ""}${why.detail ? `: ${why.detail}` : ""}`);
  if (why.reason === "replaced") {
    clients.delete(profile); // clientCurrent above makes this identity-scoped
    releasedStreams.set(releaseKey(profile, client.d.cwd), { token: client.d.token, pid: client.pid });
    if (pendingStops.get(profile)?.token === client.d.token) pendingStops.delete(profile);
    setBridge(cx, profile, { state: "off" });
    failChats(cx, profile, "disconnected");
    return;
  }
  const crashed = Boolean(why.agentExit) || why.bye === "agent-exit";
  if (!why.bye && !crashed) {
    await reopenStream(cx, profile, client, why.reason);
    return;
  }
  clients.delete(profile);
  const code = crashed ? "agent-exit" : "disconnected";
  failChats(cx, profile, code);
  const quiet = why.bye === "idle" || why.bye === "shutdown";
  setBridge(cx, profile, quiet ? { state: "stopped" } : { state: "error", error: code });
}

/** A running prompt of `hello` as its chat shows it (K3 hello `running[].prompt`): a steer's text without `/steer`,
 *  attachments by path. */
function restoredPrompt(r) {
  const text = wire.promptText(r?.prompt);
  const attachments = wire.promptPaths(r?.prompt).map((path) => ({ path }));
  if (/^\/steer\s/.test(text)) return { kind: "steer", text: text.replace(/^\/steer\s+/, ""), attachments };
  return { kind: text.startsWith("/") ? "command" : "prompt", text, attachments };
}

/** A new stream's `hello`: the agent's version; the requests this service holds in flight that the bridge no longer
 *  runs (their answers went while no stream listened: a reopened stream past the ring, a bridge that came back) fail,
 *  and those chats turn stale and load again (the selected one now); the prompts still running (their answers come
 *  later; their user items and turn logs restored) and the agent requests still waiting (approval cards) are restored
 *  into their chats. */
function onHello(cx, profile, hello) {
  const version = hello?.agent?.agentInfo?.version;
  if (typeof version === "string") S.hermes = { path: S.hermes?.path ?? null, version };
  const running = new Set((Array.isArray(hello?.running) ? hello.running : []).map((r) => String(r?.id)));
  for (const chat of chatsOf(profile)) {
    const lost = Object.keys(chat.inflight ?? {}).filter((id) => !running.has(id));
    if (!lost.length) continue;
    log(`${chat.key}: ${lost.length} request(s) the bridge no longer runs: failed, the chat loads again`);
    for (const id of lost) {
      promptKeys.delete(id);
      apply(cx, chat.key, { type: "prompt-failed", requestId: id, error: "disconnected" });
    }
    apply(cx, chat.key, { type: "disconnected" });
    if (selectedKey() === chat.key) reload(cx, chat.key);
  }
  for (const r of Array.isArray(hello?.running) ? hello.running : []) {
    const key = sessionKey(profile, r?.sessionId);
    if (!key || r.id === undefined) continue;
    const chat = ensureChat(key);
    const id = String(r.id);
    const prompt = restoredPrompt(r);
    if (!promptKeys.has(id)) promptKeys.set(id, { key, kind: prompt.kind });
    if (chat.inflight[id]) continue;
    const event = { type: "prompt-sent", requestId: r.id, ...prompt };
    logTurn(key, event);
    apply(cx, key, event);
  }
  for (const p of Array.isArray(hello?.pending) ? hello.pending : []) {
    if (p?.method !== wire.METHOD.requestPermission) continue;
    const key = sessionKey(profile, p.sessionId);
    if (!key) continue;
    const chat = ensureChat(key);
    if (chat.permissions[String(p.id)]) continue;
    apply(cx, key, { type: "permission", requestId: p.id, toolCall: p.msg?.params?.toolCall, options: p.msg?.params?.options, at: p.at });
  }
  changed(cx);
}

// ---- bridges ----------------------------------------------------------------------------------------------------

/** A client on a bridge's discovery: its stream, then its hello. Resolves `{ok, client}` or `{error}`. `since` null
 *  (a bridge this run holds no record of) asks also for the turns still running there (K3 `turns`), so a turn that
 *  began before a reload shows whole; its hello (the prompts running) is applied before those records. */
async function attach(cx, profile, d, scope, since = null) {
  if (!scopeActive(scope) || d.profile !== profile || d.cwd !== scope.folder) return { error: "disconnected" };
  const current = () => clientCurrent(profile, client);
  const client = new AcpClient({
    profile,
    discovery: d,
    nonce: `${NONCE}${++clientSeq}`,
    valid: current,
    onRecord: (rec, tcx) => { if (current()) onRecord(tcx, profile, client, rec); },
    onEvent: (ev, tcx) => { if (current()) onEvent(tcx, profile, client, ev); },
    onEnd: (why, tcx) => onEnd(tcx, profile, client, why),
  });
  client.scope = scope;
  clients.get(profile)?.close();
  clients.set(profile, client);
  let accepted = false;
  let mismatch = false;
  const ready = (hello) => {
    const target = hello?.bridge;
    if (!current()) {
      client.close();
      return;
    }
    if (target?.profile !== profile || target.cwd !== scope.folder || target.pid !== d.pid || target.startedAt !== d.startedAt) {
      mismatch = true;
      clients.delete(profile);
      client.close();
      return;
    }
    accepted = true;
    setBridge(cx, profile, { state: "ready" });
    onHello(cx, profile, hello);
  };
  const h = await client.connect(cx, since, { turns: since === null, ready });
  if (!scopeActive(scope)) return { error: "disconnected" };
  if (mismatch) return { error: "auth" };
  if (!current()) return { error: "disconnected" };
  if (h.error === "auth") {
    clients.delete(profile);
    client.close();
    return h;
  }
  return h.error ? h : accepted && client.open ? { ok: true, client } : { error: "disconnected" };
}

/** The argv a profile's bridge runs (K3): `<hermes> -p <profile> acp`, or debugAgent's. */
function argvFor(profile) {
  const debug = debugAgent();
  return debug ? agentArgv({ debugAgent: debug, profile }) : agentArgv({ bin: hermesBin, profile });
}

/** argvFor, with hermes looked up when this start has not found it yet (a lookup, not a hermes command). Null when
 *  there is no hermes. */
async function expectedArgv(profile) {
  if (!debugAgent() && !hermesBin) hermesBin = await bridge.hermesPath();
  return argvFor(profile);
}

/** Whether a connected bridge runs the agent this profile starts now (debugAgent set or cleared, another hermes). */
function sameAgent(client, profile) {
  const argv = argvFor(profile);
  return !argv || wire.discoveryMatches(client.d, { profile: client.d.profile, cwd: client.d.cwd, herdrPid: client.d.herdrPid, argv });
}

async function connectBridge(cx, profile, scope, launch) {
  const valid = () => scopeActive(scope);
  if (!valid()) return { error: "disconnected" };
  const { folder } = scope;
  if (!folder) return { error: "no-folder" };
  const pid = await bridge.herdrPid();
  if (!valid()) return { error: "disconnected" };
  if (!pid) {
    setBridge(cx, profile, { state: "error", error: "bridge-launch-failed" });
    return { error: "bridge-launch-failed", detail: "Herdr's pid is unknown" };
  }
  if (launch) setBridge(cx, profile, { state: "starting" });
  const connected = clients.get(profile);
  if (connected && !sameAgent(connected, profile)) {
    // The agent changed under a connected bridge: its requests end here, the bridge is shut down below.
    connected.close();
    failChats(cx, profile, "disconnected");
  }
  const argv = await expectedArgv(profile);
  const found = await bridge.readDiscovery(profile);
  if (!valid()) return { error: "disconnected" };
  const key = releaseKey(profile, folder);
  const released = releasedStreams.get(key);
  if (released) {
    const state = await bridge.pidState(released.pid);
    if (!valid()) return { error: "disconnected" };
    if (state !== "gone" || releasedStreams.get(key) !== released) {
      setBridge(cx, profile, { state: "off" });
      return { error: "disconnected" };
    }
    releasedStreams.delete(key);
  }
  if (found.state === "unreadable" || found.state === "invalid") {
    const r = { error: "disconnected", detail: "Bridge discovery could not be read safely" };
    if (launch) setBridge(cx, profile, { state: "error", ...r });
    return r;
  }
  const pending = pendingStops.get(profile);
  const d = found.state === "absent" && pending ? pending : found;
  const ours = d.state === "ready" && d.profile === profile && d.cwd === folder && d.herdrPid === pid;
  // Even if the released PID has since been reused, don't reconnect to its old discovery snapshot.
  if (ours && argv && released?.token !== d.token && (await bridge.pidState(d.pid)) !== "gone") {
    if (!valid()) return { error: "disconnected" };
    if (releasedStreams.get(key)?.token === d.token) return { error: "disconnected" };
    if (wire.discoveryMatches(d, { profile, cwd: folder, herdrPid: pid, argv })) {
      const from = resume.get(profile);
      const r = await attach(cx, profile, d, scope, from?.pid === d.pid ? from.seq : null);
      if (!valid()) return { error: "disconnected" };
      if (r.ok) {
        pendingStops.delete(profile);
        log(`reusing the ${profile} bridge pid ${d.pid}`);
        return r;
      }
      if (releasedStreams.get(key)?.token === d.token) return { error: "disconnected" };
      if (r.error === "auth") {
        if (launch) setBridge(cx, profile, { state: "error", error: "auth" });
        return r;
      }
      if (!launch) return r;
      log(`the ${profile} bridge pid ${d.pid} gave no hello (${r.error}): requesting shutdown`);
    } else {
      if (!launch) return { error: "disconnected" };
      log(`the ${profile} bridge pid ${d.pid} runs another agent: requesting shutdown`);
    }
    const stopped = await shutdownBridge(cx, d);
    if (!(await bridge.awaitExit(cx, profile, d.pid))) {
      pendingStops.set(profile, d);
      if (!valid()) return { error: "disconnected" };
      const r = { error: "bridge-timeout", detail: stopped.ok ? "The previous bridge has not exited" : "The previous bridge could not be confirmed stopped" };
      setBridge(cx, profile, { state: "error", ...r });
      return r;
    }
  }
  if (launch && !ours && d === pending && (await bridge.pidState(d.pid)) !== "gone") {
    const r = { error: "bridge-timeout", detail: "The previous bridge could not be confirmed stopped" };
    if (valid()) setBridge(cx, profile, { state: "error", ...r });
    return r;
  }
  if (!valid()) return { error: "disconnected" };
  if (!launch) return { error: "disconnected" };
  // A new bridge starts only once open() passed the gates (K4).
  if (S.gate !== "ok") {
    setBridge(cx, profile, { state: "off" });
    return { error: gateError() };
  }
  if (!argv) {
    setBridge(cx, profile, { state: "error", error: "hermes-missing" });
    return { error: "hermes-missing" };
  }
  // Reaping touches finished terminals only. The bridge compares and replaces discovery under its own lock.
  if (found.state !== "absent") await bridge.reap([profile]);
  const L = await bridge.launch(cx, { profile, folder, herdrPid: pid, argv, snapshot: found, valid });
  if (!valid()) {
    await bridge.cancelLaunch(L.address);
    return { error: "disconnected" };
  }
  if (L.error) {
    setBridge(cx, profile, { state: "error", error: L.error, detail: L.detail ?? null });
    return { error: L.error, detail: L.detail ?? null };
  }
  pendingStops.delete(profile);
  const r = await attach(cx, profile, L.discovery, scope);
  if (!valid()) {
    await bridge.cancelLaunch(L.address);
    return { error: "disconnected" };
  }
  if (r.error) setBridge(cx, profile, { state: "error", error: r.error });
  return r;
}

/** Registers a connect in flight for a profile until it settles. */
function inFlight(profile, promise, launch, scope) {
  const entry = { promise, launch, scope };
  launches.set(profile, entry);
  promise.then(() => {
    if (launches.get(profile) === entry) launches.delete(profile);
  });
  return promise;
}

/** A profile's client, connecting to its running bridge or launching one (`launch: false`: reuse only). Shared by
 *  concurrent callers; a caller that wants a launch while a reuse-only connect is in flight waits for it, then launches
 *  when it found no bridge. A connected bridge that runs another agent than the one this profile starts now is
 *  replaced. */
function ensureBridge(cx, profile, options) {
  const scope = folderScope();
  if (!scopeActive(scope)) return Promise.resolve({ error: "disconnected" });
  const c = activeClient(profile);
  if (c && sameAgent(c, profile)) return Promise.resolve({ ok: true, client: c });
  const launch = options?.launch !== false;
  const running = launches.get(profile);
  if (running) {
    const same = running.scope.generation === scope.generation;
    if (!same && !running.launch) {
      return inFlight(profile, owned(cx, (tcx) => connectBridge(tcx, profile, scope, launch)), launch, scope);
    }
    if (same && (running.launch || !launch)) return running.promise;
    return running.promise.then((r) => {
      if (!scopeActive(scope)) return { error: "disconnected" };
      return same && r?.ok ? r : ensureBridge(cx, profile, options);
    });
  }
  return inFlight(profile, owned(cx, (tcx) => connectBridge(tcx, profile, scope, launch)), launch, scope);
}

/**
 * Reopens a profile's stream that stopped delivering (its read loop handled no line for STALL_MS, or a load or list got
 * no answer within its bound): the client closes (its waiting requests end `disconnected`; a load then tries once
 * more) and a new one attaches from the last record held, so the bridge replays what was missed (K3 ring; `gap` when
 * the ring no longer has it). Shared with ensureBridge's callers meanwhile (as a reuse-only connect). A bridge that no
 * longer answers turns the group's state to `error` (the banner's Retry).
 */
function reopenStream(cx, profile, client, why) {
  if (!clientCurrent(profile, client)) return Promise.resolve({ error: "disconnected" });
  const running = launches.get(profile);
  if (running) return running.promise.then(() => reopenStream(cx, profile, client, why));
  const { scope } = client;
  log(`${profile}: the stream stopped (${why}); reopening it from seq ${client.seq}`);
  if (Number.isInteger(client.seq)) resume.set(profile, { pid: client.pid, seq: client.seq });
  client.close();
  const p = owned(cx, async (tcx) => {
    if (!clientCurrent(profile, client)) return { error: "disconnected" };
    const r = await attach(tcx, profile, client.d, scope, client.seq);
    if (r.error && scopeActive(scope)) {
      log(`${profile}: the stream did not reopen (${r.error})`);
      failChats(tcx, profile, r.error);
      setBridge(tcx, profile, { state: "error", error: r.error });
    }
    return r;
  });
  return inFlight(profile, p, false, scope);
}

/** Reconnects to the bridges of this folder and Herdr that still run (start; K3 reuse rule). Launches nothing. */
async function reconnectAll(cx) {
  if (!S.folder) return;
  const scope = folderScope();
  for (const profile of await bridge.discoveredProfiles()) {
    if (!scopeActive(scope)) return;
    if (!isProfileName(profile) || activeClient(profile)) continue;
    const r = await ensureBridge(cx, profile, { launch: false });
    if (r.ok) log(`reconnected to the ${profile} bridge`);
  }
  if (scopeActive(scope) && clients.size) await refreshList(cx);
}

// ---- gates and opening ------------------------------------------------------------------------------------------

async function ensureChecked() {
  const debug = debugAgent();
  const key = JSON.stringify(debug ?? "hermes");
  if (checked?.key !== key) checked = { key, promise: bridge.checkAgent(debug) };
  return checked.promise;
}

/** `retry`: the gates' Retry asked, so a `default` bridge in error starts again; a plain open leaves it to the
 *  banner's Retry (retryBridge). */
async function doOpen(cx, scope, retry) {
  if (!scopeActive(scope)) return { error: "disconnected" };
  const { folder } = scope;
  if (!folder) {
    setGate(cx, "no-folder");
    return { error: "no-folder" };
  }
  const exists = await bridge.folderExists(folder);
  if (!scopeActive(scope)) return { error: "disconnected" };
  if (!exists) {
    setGate(cx, "folder-missing");
    return { error: "no-folder" };
  }
  if (S.gate !== "ok" && !checked) setGate(cx, "checking");
  const agent = await ensureChecked();
  if (!scopeActive(scope)) return { error: "disconnected" };
  if (!agent.ok) {
    setGate(cx, agent.gate, agent.detail);
    return { error: agent.gate };
  }
  if (S.hermes?.path !== agent.bin) S.hermes = { path: agent.bin, version: S.hermes?.version ?? null };
  if (!debugAgent()) hermesBin = agent.bin;
  setGate(cx, "ok");
  await refreshList(cx);
  if (!scopeActive(scope)) return { error: "disconnected" };
  const failed = S.bridges.default?.state === "error" && !retry ? { error: S.bridges.default.error } : null;
  const b = failed ?? (await ensureBridge(cx, "default"));
  if (!scopeActive(scope)) return { error: "disconnected" };
  if (debugAgent() && b.ok) await refreshList(cx, "default");
  if (!scopeActive(scope)) return { error: "disconnected" };
  restoreSelection(cx);
  refreshFiles(cx, { force: true });
  return b.error ? { error: b.error } : { ok: true };
}

async function openFolder(cx, retry) {
  if (checking()) return { error: "disconnected" };
  const folder = settingsFolder();
  if (switching || folder !== S.folder) await owned(cx, (tcx) => switchFolder(tcx, folder));
  const scope = folderScope();
  if (!scopeActive(scope) || scope.folder !== folder || settingsFolder() !== folder) return { error: "disconnected" };
  const previous = opening;
  if (previous?.scope.generation === scope.generation) {
    if (!retry) return previous.promise;
    await previous.promise;
    if (!scopeActive(scope)) return { error: "disconnected" };
  }
  if (retry) {
    checked = null;
    setGate(cx, "checking");
  }
  const entry = { scope, promise: owned(cx, (tcx) => doOpen(tcx, scope, retry)) };
  opening = entry;
  entry.promise.then(() => {
    if (opening === entry) opening = null;
  });
  return entry.promise;
}

/** Opens the screen's data once per folder generation. The gates' Retry rechecks the agent. */
export const open = (cx) => openFolder(cx, false);
export const recheck = (cx) => openFolder(cx, true);

/** The selection remembered in `lazuli.assistant.ui` is loaded once the screen opens (D25), unless another one was
 *  made before the load starts. A profile whose bridge shows an error waits for the banner's Retry. */
function restoreSelection(cx) {
  const key = selectedKey();
  if (!key || S.bridges[parseKey(key)?.profile]?.state === "error") return;
  const chat = S.sessions[key];
  if (!chat || !chat.loaded || chat.stale) owned(cx, (tcx) => (selectedKey() === key ? doSelect(tcx, key) : { ok: true }));
}

/** A Hermes local session its bridge has no session for (a load answered without `models`): not kept. Its record goes,
 *  with the selection when it is still that one (a newer selection stays). */
function forget(cx, scope, key) {
  if (!scopeActive(scope)) return;
  const k = parseKey(key);
  const next = dropOwned(shared(KEY.assistantOwned), k.profile, k.sessionId);
  if (next) setShared(KEY.assistantOwned, next);
  S.local = S.local.filter((l) => `${l.profile}/${l.sessionId}` !== key);
  const ui = uiNow();
  if (selectedKey() === key) setUi(cx, { ...ui, selected: null });
  changed(cx);
}

// ---- the list ---------------------------------------------------------------------------------------------------

/** A profile's sessions through its bridge (`session/list {cwd, cursor}`), when the database cannot be read or
 *  debugAgent is set (K6). An unanswered list reopens the stream (reopenStream) and keeps the rows read before, so a
 *  passing failure neither empties the group nor drops the selection. */
async function listViaAgent(cx, profile) {
  const client = activeClient(profile);
  // No bridge yet: the group is still loading (a remembered selection stays, core/assistant-list.js pruneUi).
  if (!client?.open) return { profile, rows: null };
  const rows = [];
  let cursor;
  for (let page = 0; page < 10; page++) {
    const cwd = client.scope.folder;
    const r = await client.request(cx, wire.METHOD.sessionList, cursor ? { cwd, cursor } : { cwd }, { timeoutMs: LIST_MS });
    if (!scopeActive(client.scope)) return { profile, rows: null };
    if (r.error) {
      if (r.error === "bridge-timeout") reopenStream(cx, profile, client, "session/list unanswered");
      if (rows.length) return { profile, rows };
      const before = S.profiles.find((p) => p.profile === profile)?.rows;
      return Array.isArray(before) && before.length ? { profile, rows: before, error: r.error } : { profile, rows: [], error: r.error };
    }
    rows.push(...mapSessionList(r.result));
    cursor = typeof r.result?.nextCursor === "string" && r.result.nextCursor ? r.result.nextCursor : null;
    if (!cursor) break;
  }
  return { profile, rows };
}

async function listProfile(cx, profile) {
  if (debugAgent()) return listViaAgent(cx, profile);
  const scope = folderScope();
  const r = await disk.profileSessions(run, home(), profile, ownedIds(ownedNow(), scope.folder, profile));
  if (!r.error) return { profile, rows: r.rows };
  log(`${profile}: sessions not read (${r.error}: ${r.detail ?? ""})`);
  if (scopeActive(scope) && activeClient(profile)) {
    const via = await listViaAgent(cx, profile);
    if (!via.error) return via;
  }
  return { profile, rows: [], error: r.error };
}

/** Stats of the database rows into the chats (K8: refreshed on select and after each turn), the list's title into the
 *  header (fillTitle), and a stored row's title into the session made this run (kept for when the list cannot be read). */
function syncRows(cx) {
  for (const l of S.local) {
    const stored = titleText(storedOf(`${l.profile}/${l.sessionId}`)?.title);
    if (stored && !titleText(l.title)) l.title = stored;
  }
  for (const chat of Object.values(S.sessions)) {
    fillTitle(cx, chat.key);
    const stats = rowOf(chat.key)?.stats;
    if (!isObj(stats) || JSON.stringify(stats) === JSON.stringify(chat.usage?.stats)) continue;
    apply(cx, chat.key, { type: "stats", stats });
  }
}

async function doList(cx, only, scope) {
  if (!scopeActive(scope)) return { error: "disconnected" };
  if (!scope.folder) return { error: "no-folder" };
  const names = await disk.listProfiles(run, home());
  if (!scopeActive(scope)) return { error: "disconnected" };
  for (const p of clients.keys()) if (!names.includes(p)) names.push(p);
  const targets = only ? [only] : names;
  for (const profile of targets) {
    const src = await listProfile(cx, profile);
    if (!scopeActive(scope)) return { error: "disconnected" };
    const at = S.profiles.findIndex((p) => p.profile === profile);
    if (at < 0) S.profiles = [...S.profiles, src];
    else S.profiles = S.profiles.map((p, i) => (i === at ? src : p));
  }
  await resolveCwds();
  if (!scopeActive(scope)) return { error: "disconnected" };
  if (!only) {
    S.profiles = S.profiles.filter((p) => names.includes(p.profile));
    // Every profile is listed: a remembered selection that no longer exists is cleared (K2).
    const ui = uiNow();
    const pruned = pruneUi(ui, buildList({ folder: S.folder, home: home(), ...listSources(), running: [], bridges: S.bridges, ui, owned: ownedNow(), real }));
    if (pruned !== ui) setUi(cx, pruned);
  }
  syncRows(cx);
  changed(cx);
  return { ok: true };
}

/** Resolves the list's paths not resolved yet (a path that did not resolve is asked again next time). */
async function resolveCwds() {
  const wanted = pathsToResolve({ folder: S.folder, home: home(), profiles: S.profiles, local: S.local }).filter((p) => !real[p]);
  if (!wanted.length) return;
  Object.assign(real, await disk.resolvePaths(run, wanted));
}

/** Reads the list again: every profile, or one. */
export function refreshList(cx, profile) {
  if (checking()) return Promise.resolve({ error: "disconnected" });
  if (profile !== undefined && profile !== null && !isProfileName(profile)) return Promise.resolve({ error: "not-found" });
  const scope = folderScope();
  if (profile) return owned(cx, (tcx) => doList(tcx, profile, scope));
  if (listing?.scope.generation === scope.generation) return listing.promise;
  const entry = { scope, promise: owned(cx, (tcx) => doList(tcx, null, scope)) };
  listing = entry;
  entry.promise.then(() => {
    if (listing === entry) listing = null;
  });
  return entry.promise;
}

/** The list once more soon after a turn (several ends close together read it once). */
function scheduleList(cx, profile) {
  if (!profile || listSoon.has(profile)) return;
  listSoon.add(profile);
  cx.spawn(
    async (tcx) => {
      await tcx.sleep(LIST_AFTER_TURN_MS);
      listSoon.delete(profile);
      await refreshList(tcx, profile);
    },
    { owner: null },
  );
}

/** The folder's files for the @ menu, at most every few seconds unless forced, and never while a walk still runs (a
 *  forced one then follows it). */
function refreshFiles(cx, { force = false } = {}) {
  if (filesBusy && force) filesAgain = true;
  if (!S.folder || !cx || filesBusy || (!force && Date.now() - filesAt < 3000)) return;
  filesAt = Date.now();
  filesBusy = true;
  const folder = S.folder;
  try {
    cx.spawn(
      async (tcx) => {
        try {
          const files = await disk.listFolderFiles(run, folder);
          if (S.folder !== folder) return;
          if (files.length !== S.files.length || files.some((f, i) => f !== S.files[i])) {
            S.files = files;
            changed(tcx);
          }
        } finally {
          filesBusy = false;
          filesAt = Date.now();
          if (filesAgain) {
            filesAgain = false;
            refreshFiles(tcx, { force: true });
          }
        }
      },
      { owner: null },
    );
  } catch (e) {
    filesBusy = false;
    log(`the folder's files not read: ${errText(e)}`);
  }
}

// ---- the folder -------------------------------------------------------------------------------------------------

/** Stops this folder's bridges (`shutdown`: running prompts cancelled first, K3) and starts over in `folder`. */
async function switchFolder(cx, folder) {
  while (switching) await switching;
  if (settingsFolder() !== folder) return;
  if (folder === S.folder) return;
  folderGeneration++;
  const job = (async () => {
    const leaving = [...clients.values()];
    clients.clear();
    await Promise.all(
      leaving.map(async (client) => {
        client.close();
        await client.shutdown(cx); // uses the exact departing discovery token, even during stream recovery
        if (!(await bridge.awaitExit(cx, client.profile, client.pid))) pendingStops.set(client.profile, client.d);
      }),
    );
    for (const id of promptKeys.keys()) promptKeys.delete(id);
    loads.clear();
    for (const m of [turns, loadingKeys, endedInLoad, deferredLoads, seen, resume, agentTitles, filledTitles]) m.clear();
    Object.assign(S, fresh(folder), { hermes: S.hermes, notices: S.notices });
    filesAt = 0;
    log(`folder ${folder ?? "(none)"}`);
    changed(cx);
  })();
  switching = job;
  try {
    await job;
  } finally {
    if (switching === job) switching = null;
  }
}

/** A folder for the Assistant (D3, D22): with a turn running it is refused with `busy` unless `confirmed`; then the
 *  bridges stop, the folder is saved and the screen opens there. `path` in the result is the folder as kept: a path
 *  the system picker gave under macOS's `/private` is kept in its short form when that is the same folder. */
export async function setFolder(cx, path, { confirmed = false } = {}) {
  if (checking()) return { error: "disconnected" };
  const p = typeof path === "string" ? path.trim() : "";
  if (!p.startsWith("/")) return { error: "not-found" };
  // The system picker gives `/private/tmp/x` for `/tmp/x`: the short form is kept when it is the same folder.
  const folder = await disk.shortFolder(run, normalize(p));
  if (folder === S.folder && settingsFolder() === folder) {
    await recheck(cx);
    return { ok: true, path: folder };
  }
  if (!confirmed && Object.values(S.sessions).some((c) => isRunning(c))) return { error: "busy", path: folder };
  return owned(cx, async (tcx) => {
    await store.updateSettings((s) => ({ ...s, assistant: { ...(isObj(s.assistant) ? s.assistant : {}), folder } }));
    await switchFolder(tcx, folder);
    if (S.folder !== folder || settingsFolder() !== folder) return { error: "disconnected" };
    setUi(tcx, normalizeUi(null, folder));
    setGate(tcx, "checking");
    await open(tcx);
    return { ok: true, path: folder };
  });
}

/** The system folder picker, then setFolder (not confirmed): `{ok, path}`, `{error: "busy", path}` (the view asks,
 *  then calls setFolder with `confirmed`), `{error: "cancelled"}` or another error with `path`. */
export async function pickFolder(cx) {
  if (checking()) return { error: "cancelled" };
  let path = null;
  try {
    path = await pickFolderDialog();
  } catch (e) {
    log(`folder picker failed: ${errText(e)}`);
  }
  if (typeof path !== "string" || !path) return { error: "cancelled" };
  const r = await setFolder(cx, path, { confirmed: false });
  return { path, ...r };
}

// ---- sessions ---------------------------------------------------------------------------------------------------

/** `session/load` of a chat: its history replays into it (K5 rule 7), then the turn still running there, which the
 *  history does not hold yet (Hermes saves a turn when it ends): its user items and what it streamed so far, from the
 *  turn log, so it shows once and whole. A turn that ended during the load may be missing from that history: the chat
 *  then loads once more. A load without an answer within LOAD_MS reopens the stream, and one that ended `disconnected`
 *  (its stream reopened or dropped) tries once more on the bridge still running (no launch). A load result without
 *  `models` is Hermes's answer for an unknown id (S9): `not-found`. A Hermes gateway chat (a local id) with a turn
 *  running is not loaded until that turn's answer comes (afterTurn): meanwhile it shows that turn live. */
function reload(cx, key) {
  if (loads.has(key)) return loads.get(key);
  const scope = folderScope();
  const p = owned(cx, async (tcx) => {
    const k = parseKey(key);
    let pass = 0;
    let retried = false;
    for (;;) {
      if (!scopeActive(scope)) return { error: "disconnected" };
      const b = await ensureBridge(tcx, k.profile, retried ? { launch: false } : undefined);
      if (!scopeActive(scope)) return { error: "disconnected" };
      if (b.error) {
        if (retried) apply(tcx, key, { type: "loaded" }, { type: "disconnected" });
        return b;
      }
      // A reopened stream first replays what the stopped one missed (an earlier load's history among it): the load
      // starts after that, so the two never mix.
      if (retried) await b.client.caughtUp(tcx, LOAD_MS);
      if (!scopeActive(scope)) return { error: "disconnected" };
      if (!S.sessions[key]) ensureChat(key);
      // No load under a gateway turn still running (AT-25 on la-c13): the gateway's load installs a new snapshot that
      // can pass over that turn's answer (acp_adapter/gateway_server.py `_adopt`, its event watermark), which then
      // never comes, and the history it replays can already hold the turn, which the turn log would add again. Until
      // the answer comes, a chat not loaded yet shows the running turn alone, live, from its turn log.
      if (isLocalSessionId(k.sessionId) && isRunning(S.sessions[key])) {
        deferredLoads.add(key);
        if (!S.sessions[key].loaded) {
          apply(tcx, key, { type: "load-start" }, { type: "loaded" });
          resumeTurn(tcx, key);
        }
        break;
      }
      deferredLoads.delete(key);
      endedInLoad.delete(key);
      loadingKeys.add(key);
      apply(tcx, key, { type: "load-start" });
      let r;
      try {
        r = await b.client.request(tcx, wire.METHOD.sessionLoad, { sessionId: k.sessionId, cwd: scope.folder, mcpServers: [] }, { timeoutMs: LOAD_MS });
      } finally {
        if (scopeActive(scope)) loadingKeys.delete(key);
      }
      if (!scopeActive(scope)) return { error: "disconnected" };
      if (r.error) {
        const lost = r.error === "bridge-timeout" || r.error === "disconnected";
        if (lost && !retried && S.bridges[k.profile]?.state !== "error") {
          retried = true;
          log(`${key}: session/load ended ${r.error}; loading it again`);
          if (r.error === "bridge-timeout") await reopenStream(tcx, k.profile, b.client, "session/load unanswered");
          continue;
        }
        apply(tcx, key, { type: "loaded" }, { type: "disconnected" });
        return r;
      }
      if (!isObj(r.result) || !Object.prototype.hasOwnProperty.call(r.result, "models")) {
        apply(tcx, key, { type: "loaded" });
        if (isLocalSessionId(k.sessionId)) forget(tcx, scope, key);
        return { error: "not-found" };
      }
      apply(tcx, key, { type: "loaded", models: r.result.models, modes: r.result.modes });
      resumeTurn(tcx, key);
      if (pass > 0 || !endedInLoad.has(key)) break;
      pass++;
      log(`${key}: the turn ended while its history loaded; loading it again`);
    }
    endedInLoad.delete(key);
    fillTitle(tcx, key);
    const stats = rowOf(key)?.stats;
    if (isObj(stats)) apply(tcx, key, { type: "stats", stats });
    return { ok: true };
  });
  loads.set(key, p);
  p.then(() => {
    if (loads.get(key) === p) loads.delete(key);
  });
  return p;
}

/** A chat ready for a request: its bridge connected and its history loaded once there. */
async function ready(cx, key) {
  const k = parseKey(key);
  const scope = folderScope();
  const b = await ensureBridge(cx, k.profile);
  if (!scopeActive(scope)) return { error: "disconnected" };
  if (b.error) return b;
  const chat = S.sessions[key];
  if (chat && (!chat.loaded || chat.stale)) {
    const r = await reload(cx, key);
    if (r.error) return r;
  }
  const client = scopeActive(scope) && activeClient(k.profile);
  return client ? { ok: true, client } : { error: "disconnected" };
}

/** Selects a session (remembered in `lazuli.assistant.ui`) and loads its history when it is not loaded. */
async function doSelect(cx, key) {
  const k = parseKey(key);
  if (!k) return { error: "not-found" };
  if (S.gate !== "ok") return { error: gateError() };
  if (!S.sessions[key] && !rowOf(key)) return { error: "not-found" };
  const ui = uiNow();
  if (ui.selected?.profile !== k.profile || ui.selected?.session !== k.sessionId) setUi(cx, { ...ui, selected: { agent: "hermes", profile: k.profile, session: k.sessionId } });
  // Its title comes through fillTitle, so the agent's can replace a stand-in later.
  const chat = ensureChat(key, { updatedAt: rowOf(key)?.updatedAt ?? null });
  fillTitle(cx, key);
  refreshFiles(cx);
  if (chat.loaded && !chat.stale) {
    const stats = rowOf(key)?.stats;
    if (isObj(stats)) apply(cx, key, { type: "stats", stats });
    return { ok: true };
  }
  return reload(cx, key);
}

/** A notification's click: the screen with that session selected (K7 target `assistant:<profile>:<session>`). */
export function openTarget(cx, profile, sessionId) {
  const key = sessionKey(profile, sessionId);
  if (!key) return;
  showCenter(SCREEN);
  if (S.folder) {
    const ui = uiNow();
    setUi(cx, { ...ui, selected: { agent: "hermes", profile, session: sessionId } });
  }
  if (S.gate === "ok" && !checking()) owned(cx, (tcx) => doSelect(tcx, key));
}

const emptyChatOf = (key) => {
  const c = S.sessions[key];
  return !c || (!c.items.some((it) => it.type === "user") && !Object.keys(c.inflight).length && !c.queue.length);
};

/** A new chat in a profile; an unused empty one made this run is reused (K4: "+" leaves at most one). */
async function doNewSession(cx, profile = "default") {
  if (!isProfileName(profile)) return { error: "not-found" };
  if (S.gate !== "ok") return { error: gateError() };
  const unused = S.local.find((l) => l.profile === profile && emptyChatOf(`${profile}/${l.sessionId}`));
  if (unused) {
    const key = `${profile}/${unused.sessionId}`;
    const r = await doSelect(cx, key);
    return r.error ? r : { ok: true, key };
  }
  const b = await ensureBridge(cx, profile);
  if (b.error) return b;
  if (!scopeActive(b.client.scope)) return { error: "disconnected" };
  const r = await b.client.request(cx, wire.METHOD.sessionNew, { cwd: b.client.scope.folder, mcpServers: [] }, { timeoutMs: NEW_MS });
  if (!scopeActive(b.client.scope)) return { error: "disconnected" };
  if (r.error) return r;
  const sessionId = r.result?.sessionId;
  const key = sessionKey(profile, sessionId);
  if (!key) return { error: "not-found" };
  own(cx, b.client.scope, profile, sessionId);
  const now = Date.now();
  ensureChat(key, { loaded: true, updatedAt: now });
  apply(cx, key, { type: "loaded", models: r.result.models ?? null, modes: r.result.modes ?? null });
  S.local = [...S.local, { profile, sessionId, title: null, prompt: null, updatedAt: now, cwd: S.folder }];
  const ui = uiNow();
  if (ui.collapsed.includes(profile)) setUi(cx, { ...ui, collapsed: ui.collapsed.filter((p) => p !== profile) });
  const sel = await doSelect(cx, key);
  return sel.error ? sel : { ok: true, key };
}

/** A new session forked from `key` (`session/fork`); its history loads into a new row. An empty `sessionId` is
 *  Hermes's answer for an unknown source (S9): `not-found`. */
async function doFork(cx, key) {
  const k = parseKey(key);
  if (!k || (!S.sessions[key] && !rowOf(key))) return { error: "not-found" };
  if (S.gate !== "ok") return { error: gateError() };
  const b = await ready(cx, key);
  if (b.error) return b;
  if (!scopeActive(b.client.scope)) return { error: "disconnected" };
  const r = await b.client.request(cx, wire.METHOD.sessionFork, { sessionId: k.sessionId, cwd: b.client.scope.folder, mcpServers: [] }, { timeoutMs: NEW_MS });
  if (!scopeActive(b.client.scope)) return { error: "disconnected" };
  if (r.error) return r;
  const next = sessionKey(k.profile, r.result?.sessionId);
  if (!next) return { error: "not-found" };
  own(cx, b.client.scope, k.profile, r.result.sessionId);
  const now = Date.now();
  ensureChat(next, { title: titleOf(key), updatedAt: now });
  S.local = [...S.local, { profile: k.profile, sessionId: r.result.sessionId, title: titleOf(key), updatedAt: now, cwd: S.folder }];
  const sel = await doSelect(cx, next);
  return sel.error ? sel : { ok: true, key: next };
}

// ---- prompts ----------------------------------------------------------------------------------------------------

const absolute = (rel) => (String(rel).startsWith("/") ? String(rel) : `${S.folder}/${String(rel).replace(/^\.\//, "")}`);

/** Sends one session/prompt request; its answer arrives as a record (onAnswer). */
async function prompt(cx, key, client, id, blocks, entry) {
  if (!scopeActive(client.scope)) return { error: "disconnected" };
  promptKeys.set(id, entry);
  const chat = S.sessions[key];
  const r = await client.send(cx, wire.sessionPrompt(id, chat.sessionId, blocks));
  if (!scopeActive(client.scope)) return { error: "disconnected" };
  if (r.error) {
    promptKeys.delete(id);
    apply(cx, key, { type: "prompt-failed", requestId: id, error: r.error });
    afterTurn(cx, key, entry);
  }
  return r;
}

/** The queue head as a plain prompt, once nothing runs and the queue is not paused (K5 rule 6). */
function flushQueue(cx, key) {
  const chat = S.sessions[key];
  const head = chat ? queueHead(chat) : null;
  if (!head) return;
  const client = activeClient(chat.profile);
  if (!client?.open) return;
  const id = client.nextId();
  // The turn log holds the chip as the prompt it becomes (a load mid-turn shows it again).
  logTurn(key, { type: "prompt-sent", requestId: id, kind: "prompt", text: head.text, via: "queue" });
  apply(cx, key, { type: "queue-flush", requestId: id, chipId: head.id });
  prompt(cx, key, client, id, wire.promptBlocks(head.text), { key, kind: "prompt" }).then(undefined, () => {});
}

/**
 * Sends the composer's text: a prompt while idle (attachments as resource links), `/steer <text>` while a turn runs
 * (attachments as `@path` text: Hermes drops a running prompt's attachments, K4), a command the agent answers itself
 * as it is (a history-rewriting one reloads the session after). `/queue x` makes a chip and `/model x` sets the model.
 */
async function doSend(cx, key, { text, attachments = [] } = {}) {
  if (!S.sessions[key]) return { error: "not-found" };
  if (S.gate !== "ok") return { error: gateError() };
  const raw = String(text ?? "");
  const files = (Array.isArray(attachments) ? attachments : []).map((a) => (typeof a === "string" ? a : a?.path)).filter((a) => typeof a === "string" && a);
  if (!raw.trim() && !files.length) return { ok: true };
  if (raw.length > MAX_MESSAGE) return { error: "too-long" };
  const route = routeText(raw, S.sessions[key].agent);
  if (route.route === "queue") return doQueue(cx, key, route.text);
  if (route.route === "model") return doSetModel(cx, key, route.model);
  const b = await ready(cx, key);
  if (b.error) return b;
  if (!scopeActive(b.client.scope)) return { error: "disconnected" };
  const chat = S.sessions[key];
  const running = isRunning(chat);
  let kind;
  let blocks;
  if (route.route === "command") {
    kind = "command";
    blocks = wire.promptBlocks(raw.trim());
  } else if (running) {
    kind = "steer";
    const body = route.route === "steer" ? raw.trim() : `/steer ${[raw.trim(), ...files.map((f) => `@${f}`)].filter(Boolean).join(" ")}`;
    blocks = wire.promptBlocks(body);
  } else {
    kind = "prompt";
    blocks = wire.promptBlocks(raw, files.map(absolute));
  }
  const id = b.client.nextId();
  const sentEvent = { type: "prompt-sent", requestId: id, kind, text: raw, attachments: files.map((path) => ({ path })) };
  logTurn(key, sentEvent);
  apply(cx, key, ...(kind === "prompt" ? [{ type: "queue-resumed" }] : []), sentEvent);
  // A new session's first prompt line stands in for its title until the agent's is known (listTitle).
  const local = localOf(key);
  if (local && !local.prompt && kind === "prompt" && raw.trim()) {
    local.prompt = raw.trim().split("\n")[0].slice(0, 60);
    fillTitle(cx, key);
  }
  const r = await prompt(cx, key, b.client, id, blocks, { key, kind, resync: route.route === "command" && route.resync });
  return r.error ? r : { ok: true };
}

/** A lazuli-held chip (D28): sent as a plain prompt once nothing runs. */
async function doQueue(cx, key, text) {
  if (!S.sessions[key]) return { error: "not-found" };
  const s = String(text ?? "");
  if (!s.trim()) return { ok: true };
  if (s.length > MAX_MESSAGE) return { error: "too-long" };
  apply(cx, key, { type: "queued", text: s });
  return goNow(cx, key);
}

/** When the queue head would go now: the chat made ready (bridge connected, history loaded), then the head sent. */
async function goNow(cx, key) {
  if (!queueHead(S.sessions[key])) return { ok: true };
  const b = await ready(cx, key);
  if (b.error) return b;
  if (!scopeActive(b.client.scope)) return { error: "disconnected" };
  flushQueue(cx, key);
  return { ok: true };
}

export function unqueue(key, chipId) {
  if (!S.sessions[key]) return;
  apply(null, key, { type: "unqueued", chipId });
}

/** The paused chips go again: at once when nothing runs, else after the turn. */
async function doResume(cx, key) {
  if (!S.sessions[key]) return { error: "not-found" };
  apply(cx, key, { type: "queue-resumed" });
  return goNow(cx, key);
}

/** Stop: `session/cancel` (the running requests end `cancelled`) and the chips pause (K4). */
async function doStop(cx, key) {
  const chat = S.sessions[key];
  if (!chat) return { error: "not-found" };
  if (!Object.keys(chat.inflight).length) return { ok: true };
  if (chat.queue.length) apply(cx, key, { type: "queue-paused" });
  const client = activeClient(chat.profile);
  if (!client?.open) return { error: "disconnected" };
  const r = await client.send(cx, wire.sessionCancel(chat.sessionId));
  return r.error ? r : { ok: true };
}

const answering = new Map(); // `${key} ${requestId}` → the answer being sent for that approval

/** An approval's answer, by option id (D29). Past its deadline (K5 rule 4) it is refused with `too-late`. One answer
 *  per request: a second click while the first is being sent gets the first's result and sends nothing. */
function doAnswer(cx, key, requestId, optionId) {
  const id = `${folderGeneration} ${key} ${String(requestId)}`;
  if (answering.has(id)) return answering.get(id);
  const p = sendAnswer(cx, key, requestId, optionId);
  answering.set(id, p);
  const done = () => answering.delete(id);
  p.then(done, done);
  return p;
}

async function sendAnswer(cx, key, requestId, optionId) {
  const chat = S.sessions[key];
  if (!chat) return { error: "not-found" };
  const now = Date.now();
  const can = canAnswer(reduce(chat, { type: "tick" }, now), requestId, now, optionId);
  if (can.error === "not-found") return can;
  if (can.error) {
    apply(cx, key, { type: "tick" }, { type: "permission-answered", requestId, optionId });
    return can;
  }
  const client = activeClient(chat.profile);
  if (!client?.open) return { error: "disconnected" };
  const r = await client.send(cx, wire.permissionSelected(can.permission.requestId, optionId));
  if (!scopeActive(client.scope)) return { error: "disconnected" };
  if (r.error) return r;
  // Decided and sent while the card was open: its answer even when this reply comes after the deadline (K5 rule 4).
  apply(cx, key, { type: "permission-answered", requestId, optionId, sent: true });
  return { ok: true };
}

/** The session's model (`session/set_model`); refused with `busy` while a turn runs. */
async function doSetModel(cx, key, modelId) {
  const chat = S.sessions[key];
  if (!chat) return { error: "not-found" };
  if (typeof modelId !== "string" || !modelId) return { error: "not-found" };
  if (isRunning(chat)) {
    apply(cx, key, { type: "notice", code: "busy" });
    return { error: "busy" };
  }
  const b = await ready(cx, key);
  if (b.error) return b;
  if (!scopeActive(b.client.scope)) return { error: "disconnected" };
  const r = await b.client.request(cx, wire.METHOD.sessionSetModel, { sessionId: chat.sessionId, modelId }, { timeoutMs: NEW_MS });
  if (!scopeActive(b.client.scope)) return { error: "disconnected" };
  if (r.error) return r;
  apply(cx, key, { type: "model-set", modelId });
  return { ok: true };
}

/** A group's collapsed state (remembered in `lazuli.assistant.ui`). */
export function toggleGroup(profile) {
  if (!isProfileName(profile)) return;
  const ui = uiNow();
  const collapsed = ui.collapsed.includes(profile) ? ui.collapsed.filter((p) => p !== profile) : [...ui.collapsed, profile];
  setUi(null, { ...ui, collapsed });
}

/** Retry on a bridge error (the group line, the chat banner): a new bridge, the selected session loaded again. */
async function doRetry(cx, profile) {
  if (!isProfileName(profile)) return { error: "not-found" };
  if (S.gate !== "ok") return recheck(cx);
  const old = clients.get(profile);
  if (old) {
    old.close();
  }
  const r = await ensureBridge(cx, profile);
  if (r.error) return r;
  if (!scopeActive(r.client.scope)) return { error: "disconnected" };
  const key = selectedKey();
  if (key && parseKey(key)?.profile === profile && S.sessions[key]) await reload(cx, key);
  refreshList(cx, profile);
  return { ok: true };
}

// ---- start and stop ---------------------------------------------------------------------------------------------

/** The profiles whose finished bridge terminals the reaper looks for: Hermes's profile folders, the profiles listed,
 *  connected or shown with a bridge state, and those with a discovery file (hc lists a label value at a time). */
async function reapBridges() {
  const names = new Set(["default", ...S.profiles.map((p) => p.profile), ...clients.keys(), ...Object.keys(S.bridges)]);
  for (const p of await disk.listProfiles(run, home())) names.add(p);
  for (const p of await bridge.discoveredProfiles()) names.add(p);
  return bridge.reap([...names].filter(isProfileName));
}

/** The service's second: approval deadlines (K5 rule 4), streams that stopped (no line, not even a ping, for
 *  STALL_MS: reopened), finished bridge terminals (every minute), the folder's files and the list while the screen
 *  shows, and a folder changed in settings.json by hand. */
function tick(cx, n) {
  for (const chat of Object.values(S.sessions)) {
    if (Object.values(chat.permissions).some((p) => p.state === "pending")) apply(cx, chat.key, { type: "tick" });
  }
  const now = Date.now();
  for (const [profile, client] of [...clients]) {
    if (client.open && client.lastLine > 0 && now - client.lastLine > STALL_MS) reopenStream(cx, profile, client, `no line for ${Math.round((now - client.lastLine) / 1000)} s`);
  }
  if (n % REAP_EVERY === 0) reapBridges().then(undefined, (e) => log(`reap failed: ${errText(e)}`));
  const shown = blockShown(SCREEN);
  if (shown && n % FILES_EVERY === 0) refreshFiles(cx);
  if (shown && n % LIST_EVERY === 0 && S.gate === "ok") refreshList(cx);
  const folder = settingsFolder();
  if (folder !== S.folder && !switching) {
    if (shown) open(cx);
    else switchFolder(cx, folder).then(undefined, () => {});
  }
}

/** Whether this window's host is a herdr-relay device: herdr-relay refuses every program its profile does not enable,
 *  `true` among them (the probe views/apps/snapshot.js makes for the views' relay gate). A probe that fails to run
 *  counts as not a relay. */
async function onRelay() {
  try {
    const r = await exec("true", [], { timeout: 5000 });
    return r?.code === 126 && String(r.stderr ?? "").trimStart().startsWith("herdr-relay:");
  } catch {
    return false;
  }
}

/** The status copy's init: on a herdr-relay device nothing (K4: the Assistant is desktop-only); otherwise it reconnects
 *  to this folder's running bridges (no launch, no hermes command) so notices keep coming after a reload while another
 *  screen shows, fails what the chats of a profile without a bridge still hold in flight (a stop before the bridge
 *  went: they turn stale and load again), and runs the service's second. */
export function start(cx) {
  stop();
  if (checking()) return;
  const me = { stopped: false };
  service = me;
  checked = null;
  hermesBin = null;
  changed(cx);
  cx.spawn(
    async (tcx) => {
      if (await onRelay()) {
        log("a herdr-relay device: the Assistant service stays off");
        if (service === me) setGate(tcx, "relay");
        return;
      }
      try {
        // The folder comes from settings.json, read once per source version.
        await store.loadSettings();
        if (service !== me) return;
        if (switching || S.folder !== settingsFolder()) await switchFolder(tcx, settingsFolder());
        if (service !== me) return;
        await reconnectAll(tcx);
        if (service !== me) return;
        for (const profile of new Set(Object.values(S.sessions).map((c) => c.profile))) {
          if (!activeClient(profile) && chatsOf(profile).some((c) => isRunning(c) || Object.keys(c.inflight).length)) failChats(tcx, profile, "disconnected");
        }
      } catch (e) {
        log(`reconnect failed: ${errText(e)}`);
      }
      let n = 0;
      while (service === me) {
        await tcx.sleep(TICK_MS);
        if (service !== me) break;
        n++;
        try {
          tick(tcx, n);
        } catch (e) {
          log(`tick failed: ${errText(e)}`);
        }
      }
    },
    { owner: null },
  );
}

/** The status copy's close: the sockets close (where each stream stopped is kept for the next start of this build);
 *  the bridges keep running (they idle out, or exit with Herdr). */
export function stop() {
  if (!service) return;
  service.stopped = true;
  service = null;
  folderGeneration++;
  loadingKeys.clear();
  endedInLoad.clear();
  for (const key of loads.keys()) apply(null, key, { type: "load-aborted" });
  loads.clear();
  for (const client of clients.values()) {
    if (Number.isInteger(client.seq)) resume.set(client.profile, { pid: client.pid, seq: client.seq });
    client.close();
  }
  clients.clear();
  const off = {};
  for (const profile of Object.keys(S.bridges)) off[profile] = { state: "off" };
  S.bridges = off;
  version++;
}

// ---- the calls views make ---------------------------------------------------------------------------------------

/** A view's call runs in a task no view owns: it finishes even when the asking copy closes meanwhile. */
const act =
  (fn) =>
  (cx, ...args) => {
    if (checking()) return Promise.resolve({ error: "disconnected" });
    const scope = folderScope();
    return owned(cx, (tcx) => scopeActive(scope) ? fn(tcx, ...args) : { error: "disconnected" });
  };

export const select = act(doSelect);
export const newSession = act(doNewSession);
export const fork = act(doFork);
export const send = act(doSend);
export const queue = act(doQueue);
export const resumeQueue = act(doResume);
export const stopTurn = act(doStop);
export const answerPermission = act(doAnswer);
export const setModel = act(doSetModel);
export const retryBridge = act(doRetry);

/** Whether `s` is a well-formed notification target `assistant:<profile>:<sessionId>` (K7). */
export function parseTarget(s) {
  const m = /^assistant:([^:]+):([^:]+)$/.exec(String(s ?? ""));
  return m && isProfileName(m[1]) && isSessionId(m[2]) ? { profile: m[1], sessionId: m[2] } : null;
}
