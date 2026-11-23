// The Assistant's wire (plan K3, spikes S8 and S9): JSON-RPC 2.0 messages of the Agent Client Protocol, the
// lazuli bridge's line protocol (first lines, stream records, discovery files), prompt blocks, a tracker of
// in-flight prompts and pending agent requests with the bridge's idle rule, and the filter that keeps prompt
// text out of the bridge log. Used by the mod (`sys/acp-client.js`), the bridge (`bin/acp-bridge.mjs`) and
// the tests. Pure: no host modules, no clock (callers pass `now`), no randomness (callers pass nonces).

/** ACP protocol version the bridge asks for in `initialize`. */
export const PROTOCOL_VERSION = 1;
/** Discovery file format (`<profile>.json`). */
export const DISCOVERY_VERSION = 1;
/** The longest line, in bytes without its newline, either side of the bridge accepts. */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;
/** The most bytes one Herdr `net` socket write may carry (S8). Longer lines go out in pieces. */
export const MAX_WRITE_BYTES = 1048576;
/** The bridge pings a stream after this much silence; a Herdr `net` read pending 30 s fails (S8). */
export const PING_MS = 10000;
/** How long a Herdr `net` read waits before it fails with "os error 35" (S8). */
export const READ_TIMEOUT_MS = 30000;
/** A stream is lost after this many read timeouts in a row (no line, not even a ping, for about 90 s). */
export const LOST_AFTER_TIMEOUTS = 3;
/** At most this many send connections in flight per profile (S8: 1,024 host tasks per runtime). */
export const MAX_PARALLEL_SENDS = 8;
/** The first client line must arrive within this time. */
export const AUTH_MS = 5000;
/** The mod reuses a bridge only when its `hello` arrives within this time. */
export const HELLO_MS = 5000;
/** The mod waits this long for a new bridge's discovery file (S9 cold start: 0.6–1.6 s). */
export const DISCOVERY_WAIT_MS = 45000;
/** The bridge gives up on `initialize` after this long, so the mod reads `init-timeout`, not its own wait. */
export const INIT_TIMEOUT_MS = 40000;
/** The bridge's replay ring: the last records, by count and by bytes. */
export const RING_RECORDS = 4000;
export const RING_BYTES = 8 * 1024 * 1024;
/** The bridge exits after this many minutes idle (D12). */
export const IDLE_MIN = 30;

/** ACP method names lazuli sends or receives. */
export const METHOD = Object.freeze({
  initialize: "initialize",
  sessionNew: "session/new",
  sessionLoad: "session/load",
  sessionList: "session/list",
  sessionFork: "session/fork",
  sessionSetModel: "session/set_model",
  sessionSetMode: "session/set_mode",
  sessionPrompt: "session/prompt",
  sessionCancel: "session/cancel",
  sessionUpdate: "session/update",
  requestPermission: "session/request_permission",
  cancelRequest: "$/cancel_request",
});

/** Why a bridge says `bye`. `shutdown` answers `{op:"shutdown"}`. */
export const BYE_REASONS = Object.freeze(["idle", "herdr-gone", "signal", "agent-exit", "shutdown"]);
/** Error codes of a failed bridge start, in its discovery file. */
export const START_ERRORS = Object.freeze(["agent-exit", "init-failed", "init-timeout"]);
/** Error codes of a `send` reply. */
export const SEND_ERRORS = Object.freeze(["auth", "bad-request", "agent-gone", "too-large"]);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isId = (v) => typeof v === "string" || (typeof v === "number" && Number.isFinite(v));
const idKey = (id) => `${typeof id}:${id}`;

// JSON-RPC builders.

/** A request. `params` is left out when undefined. */
export function request(id, method, params) {
  return params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };
}

/** A notification (no id). */
export function notification(method, params) {
  return params === undefined ? { jsonrpc: "2.0", method } : { jsonrpc: "2.0", method, params };
}

/** A successful response to an agent's request. */
export function result(id, value) {
  return { jsonrpc: "2.0", id, result: value === undefined ? null : value };
}

/** An error response to an agent's request. */
export function rpcError(id, code, message, data) {
  const error = { code, message: String(message ?? "") };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

/** `initialize` as the bridge sends it once: protocol 1, `fs` and `terminal` off, clientInfo lazuli. */
export function initialize(id, version = "1") {
  return request(id, METHOD.initialize, {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
    clientInfo: { name: "lazuli", title: "lazuli", version: String(version) },
  });
}

export const sessionNew = (id, cwd) => request(id, METHOD.sessionNew, { cwd, mcpServers: [] });
export const sessionLoad = (id, sessionId, cwd) => request(id, METHOD.sessionLoad, { sessionId, cwd, mcpServers: [] });
export const sessionFork = (id, sessionId, cwd) => request(id, METHOD.sessionFork, { sessionId, cwd, mcpServers: [] });
export const sessionSetModel = (id, sessionId, modelId) => request(id, METHOD.sessionSetModel, { sessionId, modelId });
export const sessionSetMode = (id, sessionId, modeId) => request(id, METHOD.sessionSetMode, { sessionId, modeId });
export const sessionPrompt = (id, sessionId, prompt) => request(id, METHOD.sessionPrompt, { sessionId, prompt });
export const sessionCancel = (sessionId) => notification(METHOD.sessionCancel, { sessionId });

/** `session/list {cwd, cursor}`; the cursor only when there is one. */
export function sessionList(id, cwd, cursor) {
  const params = { cwd };
  if (typeof cursor === "string" && cursor !== "") params.cursor = cursor;
  return request(id, METHOD.sessionList, params);
}

/** The answer to `session/request_permission`: the option chosen, by its `optionId` (D29). */
export const permissionSelected = (id, optionId) => result(id, { outcome: { outcome: "selected", optionId } });
/** The answer to `session/request_permission` when the person never chose (expired, turn stopped). */
export const permissionCancelled = (id) => result(id, { outcome: { outcome: "cancelled" } });

/** Request ids: `"<nonce>:<n>"`, n from 1. The bridge's nonce is "b"; each client picks its own. */
export function createIds(nonce) {
  const prefix = String(nonce);
  let n = 0;
  return { next: () => `${prefix}:${++n}`, owns: (id) => typeof id === "string" && id.startsWith(`${prefix}:`) };
}

// Prompt blocks.

/** `file://` URI of an absolute local path, each segment percent-encoded. Null for anything else. */
export function fileUri(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.includes("\0")) return null;
  return `file://${path.split("/").map(encodeURIComponent).join("/")}`;
}

/** The ACP content blocks of a prompt: the text (when not empty), then one `resource_link` per attachment.
 *  An attachment is an absolute path or `{path, name?}`; anything else is left out. */
export function promptBlocks(text, attachments = []) {
  const blocks = [];
  if (typeof text === "string" && text !== "") blocks.push({ type: "text", text });
  for (const a of Array.isArray(attachments) ? attachments : []) {
    const path = typeof a === "string" ? a : isObj(a) ? a.path : null;
    const uri = fileUri(path);
    if (!uri) continue;
    const given = isObj(a) && typeof a.name === "string" && a.name !== "" ? a.name : null;
    blocks.push({ type: "resource_link", uri, name: given ?? (path.slice(path.lastIndexOf("/") + 1) || path) });
  }
  return blocks;
}

/** The text a prompt carries: its text blocks joined with "\n" (as Hermes joins them). */
export function promptText(blocks) {
  if (!Array.isArray(blocks)) return "";
  return blocks.filter((b) => isObj(b) && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}

// Classification.

/**
 * What a JSON-RPC message is:
 * - `{kind:"request", id, method, params, sessionId}`: it expects an answer;
 * - `{kind:"update", sessionId, update, updateKind}`: a `session/update` notification;
 * - `{kind:"notification", method, params, sessionId}`: any other notification;
 * - `{kind:"result", id, result}` or `{kind:"error", id, error:{code, message, data}}`: an answer;
 * - `{kind:"invalid"}`: anything else.
 * `params` is null when it is not an object; `sessionId` is null when params carries none.
 */
export function classify(msg) {
  if (!isObj(msg)) return { kind: "invalid" };
  if (typeof msg.method === "string") {
    const params = isObj(msg.params) ? msg.params : null;
    const sessionId = typeof params?.sessionId === "string" ? params.sessionId : null;
    if (isId(msg.id)) return { kind: "request", id: msg.id, method: msg.method, params, sessionId };
    if (msg.id !== undefined) return { kind: "invalid" };
    if (msg.method === METHOD.sessionUpdate) {
      const update = isObj(params?.update) ? params.update : null;
      const updateKind = typeof update?.sessionUpdate === "string" ? update.sessionUpdate : null;
      return { kind: "update", sessionId, update, updateKind };
    }
    return { kind: "notification", method: msg.method, params, sessionId };
  }
  if (isId(msg.id) && Object.prototype.hasOwnProperty.call(msg, "result")) return { kind: "result", id: msg.id, result: msg.result };
  if ((isId(msg.id) || msg.id === null) && isObj(msg.error)) {
    const e = msg.error;
    const error = { code: Number.isFinite(e.code) ? e.code : null, message: typeof e.message === "string" ? e.message : "" };
    if (e.data !== undefined) error.data = e.data;
    return { kind: "error", id: msg.id, error };
  }
  return { kind: "invalid" };
}

// The bridge's line protocol.

/** First line of a stream connection. `since`: the last record seq the client holds, or null for live only. */
export const streamLine = (token, since = null, client = null) => ({ op: "stream", token, since: Number.isInteger(since) && since >= 0 ? since : null, client });
/** First line of a send connection. */
export const sendLine = (token, msg) => ({ op: "send", token, msg });
/** First line of a shutdown connection. */
export const shutdownLine = (token) => ({ op: "shutdown", token });

/** A line for a socket: JSON with every non-ASCII UTF-16 unit as \uXXXX (so its length in characters is its
 *  length in bytes, whatever the host's string encoding), and the newline. */
export function encodeLine(value) {
  const json = JSON.stringify(value).replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  return `${json}\n`;
}

/** An ASCII line cut into pieces of at most `max` bytes, for one socket write each (S8). The receiver
 *  joins them by the newline. A line that is not plain ASCII is returned whole. */
export function writeChunks(line, max = MAX_WRITE_BYTES) {
  const s = String(line);
  const size = Math.max(1, Math.floor(max));
  if (s.length <= size || /[^\u0000-\u007f]/.test(s)) return [s];
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

/**
 * What one line the bridge wrote is, parsed:
 * - `{kind:"agent", seq, at, msg}`: an agent message, in the order the agent wrote it;
 * - `{kind:"event", ev, seq?, at?, …}`: `hello`, `ping`, `gap`, `replaced`, `dropped`, `agent-exit`, `bye`;
 * - `{kind:"reply", ok, error}`: the answer to a send, shutdown or refused first line;
 * - `{kind:"invalid"}`.
 */
export function parseRecord(value) {
  if (!isObj(value)) return { kind: "invalid" };
  if (Number.isInteger(value.seq) && isObj(value.msg)) return { kind: "agent", seq: value.seq, at: value.at ?? null, msg: value.msg };
  if (typeof value.ev === "string" && value.ev !== "") return { ...value, kind: "event" };
  if (value.ok === true) return { kind: "reply", ok: true, error: null };
  if (value.ok === false && isObj(value.error) && typeof value.error.code === "string") return { kind: "reply", ok: false, error: { code: value.error.code } };
  return { kind: "invalid" };
}

// Discovery.

const TOKEN_RE = /^[0-9a-f]{64}$/;
const posInt = (v) => Number.isInteger(v) && v > 0;

/** A discovery file's text, checked:
 *  `{state:"ready", pid, agentPid, port, token, profile, cwd, herdrPid, startedAt}`,
 *  `{state:"failed", pid, code, detail}` (a start that failed), or `{state:"invalid"}`. */
export function parseDiscovery(text) {
  let d;
  try {
    d = JSON.parse(String(text));
  } catch {
    return { state: "invalid" };
  }
  if (!isObj(d) || d.version !== DISCOVERY_VERSION || !posInt(d.pid)) return { state: "invalid" };
  if (isObj(d.error)) {
    const code = START_ERRORS.includes(d.error.code) ? d.error.code : "init-failed";
    return { state: "failed", pid: d.pid, code, detail: typeof d.error.detail === "string" ? d.error.detail : "" };
  }
  const ok =
    posInt(d.agentPid) &&
    Number.isInteger(d.port) &&
    d.port > 0 &&
    d.port < 65536 &&
    typeof d.token === "string" &&
    TOKEN_RE.test(d.token) &&
    typeof d.profile === "string" &&
    d.profile !== "" &&
    typeof d.cwd === "string" &&
    d.cwd.startsWith("/") &&
    posInt(d.herdrPid) &&
    Number.isFinite(d.startedAt);
  if (!ok) return { state: "invalid" };
  const { pid, agentPid, port, token, profile, cwd, herdrPid, startedAt } = d;
  return { state: "ready", pid, agentPid, port, token, profile, cwd, herdrPid, startedAt };
}

/** Whether a ready discovery belongs to this profile, folder and Herdr (K3 reuse rule; the caller also
 *  checks that its pid is alive and that `hello` arrives within HELLO_MS). */
export function discoveryMatches(d, { profile, cwd, herdrPid }) {
  return isObj(d) && d.state === "ready" && d.profile === profile && d.cwd === cwd && d.herdrPid === herdrPid;
}

// The tracker.

/**
 * In-flight prompts, pending agent requests and the idle rule, fed with every message each way:
 * - `fromClient(msg, now)`: a message the client sent the agent. A `session/prompt` request is in flight
 *   until its answer; an answer to an agent request ends that request.
 * - `fromAgent(msg, now, seq)`: a message from the agent. An answer ends its prompt; when the last prompt of
 *   a session ends, that session's agent requests end too (Hermes stops waiting for a permission after
 *   60 s without saying so). An agent request is pending until answered or cancelled (`$/cancel_request`).
 * - `idleExpired(now, idleMs)`: no message either way for idleMs, nothing in flight, nothing pending
 *   (D12; pings and stream connects are not messages).
 */
export function createTracker(now = 0) {
  const running = new Map(); // idKey → {id, sessionId, at}
  const pending = new Map(); // idKey → {id, method, sessionId, at, seq, msg}
  let last = Number.isFinite(now) ? now : 0;
  const touch = (t) => {
    if (Number.isFinite(t) && t > last) last = t;
  };
  const sessionRunning = (sessionId) => [...running.values()].some((r) => r.sessionId === sessionId);
  return {
    fromClient(msg, t) {
      touch(t);
      const c = classify(msg);
      if (c.kind === "request" && c.method === METHOD.sessionPrompt) running.set(idKey(c.id), { id: c.id, sessionId: c.sessionId, at: t });
      else if (c.kind === "result" || c.kind === "error") pending.delete(idKey(c.id));
      return c;
    },
    fromAgent(msg, t, seq = null) {
      touch(t);
      const c = classify(msg);
      if (c.kind === "result" || c.kind === "error") {
        const k = idKey(c.id);
        const r = running.get(k);
        if (r) {
          running.delete(k);
          if (!sessionRunning(r.sessionId)) for (const [pk, p] of pending) if (p.sessionId === r.sessionId) pending.delete(pk);
        }
      } else if (c.kind === "request") {
        pending.set(idKey(c.id), { id: c.id, method: c.method, sessionId: c.sessionId, at: t, seq, msg });
      } else if (c.kind === "notification" && c.method === METHOD.cancelRequest) {
        const id = c.params?.requestId ?? c.params?.id;
        if (isId(id)) pending.delete(idKey(id));
      }
      return c;
    },
    /** Something happened that counts as activity without being a message. */
    touch,
    /** In-flight prompts `[{id, sessionId, at}]`, oldest first. */
    running: () => [...running.values()],
    /** Sessions with a prompt in flight, each once. */
    runningSessions: () => [...new Set([...running.values()].map((r) => r.sessionId).filter((s) => s !== null))],
    /** Pending agent requests `[{id, method, sessionId, at, seq, msg}]`, oldest first. */
    pending: () => [...pending.values()],
    busy: () => running.size > 0 || pending.size > 0,
    lastActivity: () => last,
    idleExpired(t, idleMs) {
      return running.size === 0 && pending.size === 0 && t - last >= idleMs;
    },
    /** The agent is gone: nothing is in flight any more. */
    clear() {
      running.clear();
      pending.clear();
    },
  };
}

// The agent's stderr.

const RECORD_START = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/;
const PROMPT_LINE = /^(.*?\bPrompt on session (\S+): )(.*)$/;
const PREVIEW_CHARS = 100;
const codePoints = (s) => Array.from(s).length;

/**
 * Keeps prompt text out of the log. Hermes logs the first 100 characters of each prompt to stderr
 * (`acp_adapter/server.py:1383`, `Prompt on session %s: %s`; S9). Such a line keeps its prefix and session id,
 * and its text becomes `[<n> chars]`, n from `promptLength(sessionId)` (the prompt the bridge forwarded) or
 * `[redacted]` when unknown. The preview's own newlines continue it on the next lines: those are dropped while
 * they fit in the 100 characters and do not start a new log record.
 * `push(text)` takes stderr text in any pieces and returns the complete lines, filtered; `end()` the rest.
 */
export function createStderrFilter({ promptLength = () => null } = {}) {
  let rest = "";
  let budget = 0;
  const filter = (line) => {
    if (budget > 0 && !RECORD_START.test(line) && codePoints(line) + 1 <= budget) {
      budget -= codePoints(line) + 1;
      return null;
    }
    budget = 0;
    const m = PROMPT_LINE.exec(line);
    if (!m) return line;
    budget = Math.max(0, PREVIEW_CHARS - codePoints(m[3]));
    const n = promptLength(m[2]);
    return `${m[1]}${Number.isInteger(n) ? `[${n} chars]` : "[redacted]"}`;
  };
  const run = (lines) => lines.map(filter).filter((l) => l !== null);
  return {
    push(text) {
      const all = rest + String(text);
      const parts = all.split("\n");
      rest = parts.pop();
      return run(parts.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l)));
    },
    end() {
      const last = rest;
      rest = "";
      return last === "" ? [] : run([last]);
    },
  };
}
