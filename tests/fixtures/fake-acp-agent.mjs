#!/usr/bin/env node
// Fake ACP agent (CONTRACTS K9): speaks ACP over stdio like Hermes Agent 0.17.0, one JSON-RPC object per
// line both ways, so the bridge, the service and the views can be driven without a model.
//
//   node fake-acp-agent.mjs [--fail-check] -p <profile> acp            serve ACP on stdin/stdout
//   node fake-acp-agent.mjs [--fail-check] [-p <profile>] acp --check   "Hermes ACP check OK", exit 0
//                                                                       (--fail-check: "fake: check failed"
//                                                                       on stderr, exit 1)
//
// Shapes: tests/fixtures/acp/hermes-0.17.0.json, copied from docs/spikes/S9/*.jsonl (initialize result,
// modes, advertised commands, /help and /version texts) and from Hermes's own ACP SDK serializer (tool
// calls, permission requests, plan, session info). Facts from the Hermes source (~/.hermes/hermes-agent):
// - session ids are UUID v4 (acp_adapter/session.py:215); `session/load` of an unknown id answers `{}`
//   and `session/fork` of one answers `{sessionId: ""}` (S9);
// - `session/new` and `session/fork` notifications follow the response; slash-command answers and load
//   replay precede it (server.py:1152, 1359-1363, 1712-1719, 781-786);
// - a text-only prompt starting with `/` is answered locally for help, model, steer, queue and version;
//   `/steer <x>` on an idle session runs `<x>` as a normal prompt (server.py:1331-1350); a plain prompt
//   while a turn runs is queued (server.py:1366-1379) and queued prompts run after the turn;
// - the steer acknowledgement is `⏩ Steer queued for the active turn: {preview}`, preview = first 80
//   characters plus "..." (server.py:1964-1965);
// - approval options (acp_adapter/permissions.py:41-69, edit_approval.py:254-257); Hermes waits 60 s;
// - stderr logs `Prompt on session <id>: <first 100 chars>` (server.py:1383), which the bridge rewrites.
//
// Prompt behavior by the first word of the prompt text (K9): (other) echo, tool, edit, approve, approve2,
// slow, plan, burst, bigdiff, fail, crash; `/help`, `/version`; resource_link URIs are echoed.
//
// Sessions persist as $FAKE_ACP_HOME/<profile>/<sessionId>.json (FAKE_ACP_HOME defaults to
// /tmp/fake-acp), so `session/load` replays them after a restart, as Hermes replays its history.
//
// Test knobs (environment, all optional):
//   FAKE_ACP_PERMISSION_MS   how long a permission request waits for an answer (default 60000)
//   FAKE_ACP_INIT            fail: `initialize` answers a JSON-RPC error; hang: never answers;
//                            exit: the process exits 1 on `initialize`
//   FAKE_ACP_IGNORE_TERM=1   ignore SIGTERM (exercises a client's SIGKILL escalation)
//   FAKE_ACP_LOG=<file>      append every received line to <file>

import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, normalize } from "node:path";

const SHAPES = JSON.parse(readFileSync(new URL("./acp/hermes-0.17.0.json", import.meta.url), "utf8"));
const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SESSION_ID = /^[0-9a-f-]{36}$/;
const MODELS = [
  { modelId: "fake:alpha", name: "alpha" },
  { modelId: "fake:beta", name: "beta" },
];
const PERMISSION_MS = Number(process.env.FAKE_ACP_PERMISSION_MS) > 0 ? Number(process.env.FAKE_ACP_PERMISSION_MS) : 60000;
const ECHO_CHUNKS = 5;
const ECHO_STEP_MS = 200; // 5 chunks over 1 s
const TOOL_MS = 1500;
const SLOW_CHUNKS = 20;
const SLOW_STEP_MS = 1000;
const BURST_ITEMS = 2100;
const BIGDIFF_BYTES = 1024 * 1024;

// ---- argv -------------------------------------------------------------------------------------------

const argv = process.argv.slice(2);
const failCheck = argv.includes("--fail-check");
const pIndex = argv.indexOf("-p");
const profile = pIndex >= 0 ? argv[pIndex + 1] : "default";
if (!argv.includes("acp") || typeof profile !== "string" || !PROFILE_NAME.test(profile)) {
  process.stderr.write("usage: fake-acp-agent.mjs [--fail-check] -p <profile> acp [--check]\n");
  process.exit(2);
}
if (argv.includes("--check")) {
  if (failCheck) {
    process.stderr.write("fake: check failed\n");
    process.exit(1);
  }
  process.stdout.write("Hermes ACP check OK\n");
  process.exit(0);
}

const HOME = process.env.FAKE_ACP_HOME || "/tmp/fake-acp";
const STORE = join(HOME, profile);

// ---- output -----------------------------------------------------------------------------------------

const pad = (n, w = 2) => String(n).padStart(w, "0");
function log(level, logger, text) {
  const d = new Date();
  const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  process.stderr.write(`${ts} [${level}] ${logger}: ${text}\n`);
}
/** Python's `datetime.now(timezone.utc).isoformat()` form, as Hermes sends `updatedAt`. */
const isoNow = () => new Date().toISOString().replace("Z", "000+00:00");

const line = (msg) => JSON.stringify(msg) + "\n";
const send = (msg) => process.stdout.write(line(msg));
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const notification = (sessionId, update) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update } });
const update = (sessionId, u) => send(notification(sessionId, u));
const text = (t) => ({ text: t, type: "text" });
const toolText = (t) => ({ content: text(t), type: "content" });
const chunk = (sessionId, t) => update(sessionId, { content: text(t), sessionUpdate: "agent_message_chunk" });

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

// ---- sessions ---------------------------------------------------------------------------------------

const sessions = new Map();

function persist(s) {
  mkdirSync(STORE, { recursive: true });
  const file = join(STORE, `${s.id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  const { id, cwd, model, mode, title, createdAt, updatedAt, history } = s;
  writeFileSync(tmp, JSON.stringify({ version: 1, sessionId: id, profile, cwd, model, mode, title, createdAt, updatedAt, history }));
  renameSync(tmp, file);
}

function revive(data) {
  return {
    id: data.sessionId,
    cwd: data.cwd,
    model: MODELS.some((m) => m.modelId === data.model) ? data.model : MODELS[0].modelId,
    mode: data.mode || SHAPES.modes.currentModeId,
    title: data.title ?? null,
    createdAt: data.createdAt,
    updatedAt: data.updatedAt,
    history: Array.isArray(data.history) ? data.history : [],
    turn: null,
    queued: [],
    interrupted: "",
  };
}

function getSession(id) {
  if (typeof id !== "string" || !SESSION_ID.test(id)) return null;
  if (sessions.has(id)) return sessions.get(id);
  try {
    const s = revive(JSON.parse(readFileSync(join(STORE, `${id}.json`), "utf8")));
    sessions.set(id, s);
    return s;
  } catch {
    return null;
  }
}

function createSession(cwd, from) {
  const now = isoNow();
  const s = revive({
    sessionId: randomUUID(),
    cwd,
    model: from?.model,
    mode: from?.mode,
    title: null,
    createdAt: now,
    updatedAt: now,
    history: from ? structuredClone(from.history) : [],
  });
  sessions.set(s.id, s);
  persist(s);
  log("INFO", "acp_adapter.session", `Created ACP session ${s.id} (cwd=${cwd})`);
  return s;
}

const normCwd = (p) => normalize(String(p || ".").trim().replace(/^~(?=\/|$)/, homedir())).replace(/(.)\/+$/, "$1");

const modelState = (s) => ({
  availableModels: MODELS.map((m) => ({
    description: `Provider: Fake${m.modelId === s.model ? " • current" : ""}`,
    modelId: m.modelId,
    name: m.name,
  })),
  currentModelId: s.model,
});
const modeState = (s) => ({ ...structuredClone(SHAPES.modes), currentModeId: s.mode });
const provenance = (s) => ({
  hermes: {
    sessionProvenance: {
      acpSessionId: s.id,
      currentHermesSessionId: s.id,
      rootHermesSessionId: s.id,
      parentHermesSessionId: null,
      sessionKind: "root",
      compressionDepth: 0,
    },
  },
});

function historyChars(s) {
  let n = 0;
  for (const m of s.history) n += (m.content?.length || 0) + (m.reasoning?.length || 0);
  return n;
}
const usageUpdate = (s) =>
  update(s.id, { size: SHAPES.usage.size, used: SHAPES.usage.used + Math.ceil(historyChars(s) / 4), sessionUpdate: "usage_update" });
const commandsUpdate = (s) =>
  update(s.id, { availableCommands: structuredClone(SHAPES.availableCommands), sessionUpdate: "available_commands_update" });

// ---- tool-call shapes (acp_adapter/tools.py build_tool_start / build_tool_complete) -------------------

const terminalTitle = (cmd) => `terminal: ${cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd}`;
const terminalOutput = (cmd) => `terminal result\n- **output:** fake output of \`${cmd}\`\n- **exit_code:** 0`;
const toolStart = (id, name, args) =>
  name === "patch"
    ? {
        content: [toolText(`Preparing ${args.mode} edit for ${args.path}. Approval prompt shows the diff.`)],
        kind: "edit",
        locations: [{ path: args.path }],
        title: `patch (${args.mode}): ${args.path}`,
        toolCallId: id,
        sessionUpdate: "tool_call",
      }
    : { content: [toolText(`$ ${args.command}`)], kind: "execute", locations: [], title: terminalTitle(args.command), toolCallId: id, sessionUpdate: "tool_call" };
function toolComplete(id, name, result, args) {
  let failed = false;
  let detail = null;
  try {
    const data = JSON.parse(result);
    if (data && typeof data === "object" && data.error) [failed, detail] = [true, data.error];
  } catch {}
  const body =
    name === "patch"
      ? failed
        ? `patch failed for ${args.path}: ${detail}`
        : `✅ patch completed for \`${args.path}\``
      : result;
  return { content: [toolText(body)], kind: name === "patch" ? "edit" : "execute", status: failed ? "failed" : "completed", toolCallId: id, sessionUpdate: "tool_call_update" };
}
const toolCallId = () => `tc-${randomBytes(6).toString("hex")}`;

// ---- replay (server.py _replay_session_history) -------------------------------------------------------

function replay(s) {
  const out = [];
  const active = new Map();
  for (const m of s.history) {
    if (m.role === "user" && m.content) out.push({ content: text(m.content), sessionUpdate: "user_message_chunk" });
    if (m.role === "assistant") {
      if (m.reasoning) out.push({ content: text(m.reasoning), sessionUpdate: "agent_thought_chunk" });
      if (m.content) out.push({ content: text(m.content), sessionUpdate: "agent_message_chunk" });
      for (const tc of m.tool_calls || []) {
        active.set(tc.id, tc);
        out.push(toolStart(tc.id, tc.name, tc.args));
      }
    }
    if (m.role === "tool") {
      const tc = active.get(m.tool_call_id);
      if (!tc) continue;
      active.delete(m.tool_call_id);
      out.push(toolComplete(tc.id, tc.name, m.content, tc.args));
    }
  }
  if (out.length) process.stdout.write(out.map((u) => line(notification(s.id, u))).join(""));
}

// ---- outgoing requests (permission) -----------------------------------------------------------------

let nextOutId = 0; // the ACP SDK numbers the agent's own requests from 0
const pendingOut = new Map();
let permCheckN = 0; // permissions.py `perm-check-N`
let editApprovalN = 0; // edit_approval.py `edit-approval-N`

/** Sends `session/request_permission` and resolves with the outcome; no answer in PERMISSION_MS or a
 *  cancelled turn gives `{outcome: "cancelled"}`. A late answer is ignored. */
function askPermission(s, turn, toolCall, options) {
  const id = nextOutId++;
  return new Promise((resolve) => {
    const done = (outcome) => {
      if (!pendingOut.has(id)) return;
      pendingOut.delete(id);
      clearTimeout(timer);
      turn.ctrl.signal.removeEventListener("abort", onAbort);
      resolve(outcome && typeof outcome === "object" ? outcome : { outcome: "cancelled" });
    };
    const onAbort = () => done({ outcome: "cancelled" });
    const timer = setTimeout(() => {
      log("WARNING", "acp_adapter.permissions", "Permission request timed out or failed: TimeoutError()");
      done({ outcome: "cancelled" });
    }, PERMISSION_MS);
    pendingOut.set(id, (msg) => done(msg.result?.outcome));
    turn.ctrl.signal.addEventListener("abort", onAbort, { once: true });
    send({ jsonrpc: "2.0", id, method: "session/request_permission", params: { options, sessionId: s.id, toolCall } });
  });
}

const HERMES_OPTIONS = (allowPermanent) => [
  { kind: "allow_once", name: "Allow once", optionId: "allow_once" },
  { kind: "allow_always", name: "Allow for session", optionId: "allow_session" },
  ...(allowPermanent ? [{ kind: "allow_always", name: "Allow always", optionId: "allow_always" }] : []),
  { kind: "reject_once", name: "Deny", optionId: "deny" },
  { kind: "reject_always", name: "Deny always", optionId: "deny_always" },
];
const EDIT_OPTIONS = () => [
  { kind: "allow_once", name: "Allow edit", optionId: "allow_once" },
  { kind: "reject_once", name: "Deny", optionId: "deny" },
];

// ---- turns ------------------------------------------------------------------------------------------

/** Waits `ms` unless the turn is cancelled first; false when cancelled. */
function pause(ms, turn) {
  return new Promise((resolve) => {
    const signal = turn.ctrl.signal;
    if (signal.aborted) return resolve(false);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Streams accepted steers into the running turn, as the steered model would. */
function flushSteers(s, turn, said) {
  while (turn.steers.length) {
    const t = `Steered: ${turn.steers.shift()}`;
    chunk(s.id, t);
    said.push(t);
  }
}

/** `t` in `n` pieces of near-equal length (exactly `n` when `t` has at least `n` characters). */
function split(t, n) {
  const chars = [...t];
  const parts = [];
  for (let i = 0; i < n; i++) parts.push(chars.slice(Math.floor((i * chars.length) / n), Math.floor(((i + 1) * chars.length) / n)).join(""));
  return parts.filter((p) => p !== "");
}

function answer(s, t, said) {
  chunk(s.id, t);
  said.push(t);
}

const BEHAVIORS = {
  async echo(s, turn, { text: t, links }, said, entries) {
    const thought = `Thinking about: ${t}`;
    update(s.id, { content: text(thought), sessionUpdate: "agent_thought_chunk" });
    const full = `Echo: ${t}` + (links.length ? `\n\nAttachments:\n${links.map((u) => `- ${u}`).join("\n")}` : "");
    for (const part of split(full, ECHO_CHUNKS)) {
      if (!(await pause(ECHO_STEP_MS, turn))) break;
      flushSteers(s, turn, said);
      answer(s, part, said);
    }
    flushSteers(s, turn, said);
    entries.push({ role: "assistant", content: said.join(""), reasoning: thought });
  },

  async tool(s, turn, { rest }, said, entries) {
    const command = rest || "ls";
    const id = toolCallId();
    const args = { command };
    update(s.id, { ...toolStart(id, "terminal", args), status: "pending" });
    entries.push({ role: "assistant", content: "", tool_calls: [{ id, name: "terminal", args }] });
    if (!(await pause(100, turn))) return void update(s.id, { kind: "execute", status: "failed", toolCallId: id, sessionUpdate: "tool_call_update" });
    update(s.id, { kind: "execute", status: "in_progress", toolCallId: id, sessionUpdate: "tool_call_update" });
    if (!(await pause(TOOL_MS - 100, turn))) return void update(s.id, { kind: "execute", status: "failed", toolCallId: id, sessionUpdate: "tool_call_update" });
    const output = terminalOutput(command);
    update(s.id, toolComplete(id, "terminal", output, args));
    entries.push({ role: "tool", tool_call_id: id, tool_name: "terminal", content: output });
    answer(s, `Ran \`${command}\`; it printed fake output.`, said);
    entries.push({ role: "assistant", content: said.join("") });
  },

  edit: (s, turn, input, said, entries) => edit(s, turn, input, said, entries, false),
  bigdiff: (s, turn, input, said, entries) => edit(s, turn, input, said, entries, true),

  approve: (s, turn, input, said, entries) => approve(s, turn, input, said, entries, true),
  approve2: (s, turn, input, said, entries) => approve(s, turn, input, said, entries, false),

  async slow(s, turn, input, said, entries) {
    for (let i = 1; i <= SLOW_CHUNKS; i++) {
      if (!(await pause(SLOW_STEP_MS, turn))) break;
      flushSteers(s, turn, said);
      answer(s, `Slow chunk ${i}/${SLOW_CHUNKS}. `, said);
    }
    flushSteers(s, turn, said);
    entries.push({ role: "assistant", content: said.join("") });
  },

  async plan(s, turn, input, said, entries) {
    update(s.id, {
      entries: [
        { content: "Read the request", priority: "medium", status: "completed" },
        { content: "Draft the answer", priority: "medium", status: "in_progress" },
        { content: "Check the result", priority: "medium", status: "pending" },
      ],
      sessionUpdate: "plan",
    });
    if (!(await pause(200, turn))) return;
    answer(s, "Plan ready: three steps.", said);
    entries.push({ role: "assistant", content: said.join("") });
  },

  async burst(s, turn, input, said, entries) {
    const calls = [];
    const results = [];
    let out = "";
    for (let i = 0; i < BURST_ITEMS; i++) {
      const id = toolCallId();
      const args = { command: `echo ${i}` };
      const result = terminalOutput(args.command);
      calls.push({ id, name: "terminal", args });
      results.push({ role: "tool", tool_call_id: id, tool_name: "terminal", content: result });
      out += line(notification(s.id, { ...toolStart(id, "terminal", args), status: "completed" }));
    }
    process.stdout.write(out);
    entries.push({ role: "assistant", content: "", tool_calls: calls }, ...results);
    answer(s, `Burst: ${BURST_ITEMS} tool calls.`, said);
    entries.push({ role: "assistant", content: said.join("") });
  },

  async fail(s) {
    log("ERROR", "acp_adapter.server", `Executor error for session ${s.id}`);
    throw new RpcError(-32603, "Internal error", { details: "fake: prompt failed" });
  },

  async crash() {
    process.stderr.write("fake: crash requested\n");
    process.exit(1);
  },
};

async function edit(s, turn, { rest }, said, entries, big) {
  const word = rest.split(/\s+/)[0] || "";
  const rel = big ? "big.txt" : word ? (word.includes(".") ? word : `${word}.md`) : "notes.md";
  const path = join(s.cwd, rel);
  const oldText = big ? "old\n" : "# Notes\n\nold line\n";
  const newText = big ? bigText() : "# Notes\n\nnew line from the fake agent\n";
  const id = toolCallId();
  const args = { mode: "replace", path };
  update(s.id, { ...toolStart(id, "patch", args), status: "pending" });
  entries.push({ role: "assistant", content: "", tool_calls: [{ id, name: "patch", args }] });
  const diff = { newText, oldText, path, type: "diff" };
  const outcome = await askPermission(
    s,
    turn,
    {
      content: [diff],
      kind: "edit",
      rawInput: { tool: "patch", arguments: { mode: "replace", path, old_string: big ? "old" : "old line", new_string: big ? "<1 MiB>" : "new line from the fake agent" } },
      status: "pending",
      title: `Approve edit: ${path}`,
      toolCallId: `edit-approval-${++editApprovalN}`,
    },
    EDIT_OPTIONS(),
  );
  const allowed = outcome.outcome === "selected" && outcome.optionId === "allow_once";
  if (allowed) {
    update(s.id, { content: [diff], kind: "edit", status: "completed", toolCallId: id, sessionUpdate: "tool_call_update" });
    entries.push({ role: "tool", tool_call_id: id, tool_name: "patch", content: JSON.stringify({ success: true }) });
  } else {
    const error = "Edit approval denied by ACP client; file was not modified.";
    update(s.id, { content: [toolText(JSON.stringify({ error }))], kind: "edit", status: "failed", toolCallId: id, sessionUpdate: "tool_call_update" });
    entries.push({ role: "tool", tool_call_id: id, tool_name: "patch", content: JSON.stringify({ error }) });
  }
  if (turn.ctrl.signal.aborted) return;
  answer(s, allowed ? `Edited ${rel}.` : `The edit of ${rel} was not approved.`, said);
  entries.push({ role: "assistant", content: said.join("") });
}

function bigText() {
  const row = "+ a line of the big fake diff, padded to a fixed width ......................\n";
  return row.repeat(Math.ceil(BIGDIFF_BYTES / row.length));
}

async function approve(s, turn, { rest }, said, entries, allowPermanent) {
  const command = rest || "rm -rf /tmp/fake-acp-demo";
  const description = "fake dangerous command";
  const options = HERMES_OPTIONS(allowPermanent);
  const outcome = await askPermission(
    s,
    turn,
    {
      content: [toolText(`${description}\n$ ${command}`)],
      kind: "execute",
      rawInput: { command, description },
      status: "pending",
      title: `${description}: ${command}`,
      toolCallId: `perm-check-${++permCheckN}`,
    },
    options,
  );
  if (turn.ctrl.signal.aborted) return;
  const chosen = outcome.outcome === "selected" && options.some((o) => o.optionId === outcome.optionId) ? outcome.optionId : null;
  answer(s, chosen ? `Chosen option: ${chosen}` : "Permission outcome: cancelled", said);
  entries.push({ role: "assistant", content: said.join("") });
}

/** One model turn (server.py prompt): runs the behavior, drains Hermes's own queue, sends
 *  `usage_update` and returns the PromptResponse. */
async function runTurn(s, input) {
  const turn = { ctrl: new AbortController(), steers: [] };
  s.turn = turn;
  log("INFO", "acp_adapter.server", `Prompt on session ${s.id}: ${input.text.slice(0, 100)}`);
  const said = [];
  const entries = [{ role: "user", content: input.text }];
  const word = input.text.trim().split(/\s+/)[0]?.toLowerCase() || "";
  const behavior = Object.hasOwn(BEHAVIORS, word) && word !== "echo" ? BEHAVIORS[word] : BEHAVIORS.echo;
  const rest = input.text.trim().slice(word.length).trim();
  try {
    await behavior(s, turn, { ...input, rest }, said, entries);
  } finally {
    s.turn = null;
  }
  const cancelled = turn.ctrl.signal.aborted;
  if (cancelled) s.interrupted = input.text;
  s.history.push(...entries);
  s.updatedAt = isoNow();
  persist(s);
  const titled = !cancelled && said.length > 0 && !s.title;
  if (titled) {
    s.title = `Fake: ${input.text.trim().slice(0, 40)}`;
    persist(s);
    // Hermes titles the session in the background and sends session_info_update after the turn.
    setImmediate(() =>
      update(s.id, { _meta: provenance(s), title: s.title, updatedAt: s.updatedAt, sessionUpdate: "session_info_update" }),
    );
  }
  while (s.queued.length) {
    const next = s.queued.shift();
    update(s.id, { content: text(next), sessionUpdate: "user_message_chunk" });
    try {
      await runTurn(s, { text: next, links: [] });
    } catch {
      // a queued turn has no request to answer; its failure is only logged
    }
  }
  usageUpdate(s);
  if (cancelled) return { stopReason: "cancelled" };
  const input_tokens = SHAPES.usage.used + Math.ceil(input.text.length / 4);
  const output_tokens = Math.ceil(said.join("").length / 4);
  return { stopReason: "end_turn", usage: { inputTokens: input_tokens, outputTokens: output_tokens, totalTokens: input_tokens + output_tokens } };
}

function slashAnswer(s, t) {
  const [, name, args = ""] = /^\/(\S*)\s*([\s\S]*)$/.exec(t);
  switch (name) {
    case "help":
      return SHAPES.helpText;
    case "version":
      return SHAPES.versionText;
    case "model": {
      if (!args.trim()) return `Current model: ${s.model}\nProvider: fake`;
      const want = args.trim();
      const m = MODELS.find((x) => x.modelId === want || x.name === want || x.modelId === `fake:${want}`);
      if (!m) return `Unknown model: ${want}. Available: ${MODELS.map((x) => x.modelId).join(", ")}`;
      s.model = m.modelId;
      persist(s);
      return `Model switched to: ${m.modelId}\nProvider: fake`;
    }
    case "steer": {
      const guidance = args.trim();
      if (!guidance) return "Usage: /steer <guidance>";
      if (s.turn) {
        s.turn.steers.push(guidance);
        return `⏩ Steer queued for the active turn: ${guidance.slice(0, 80)}${guidance.length > 80 ? "..." : ""}`;
      }
      s.queued.push(guidance);
      return `No active turn — queued for the next turn. (${s.queued.length} queued)`;
    }
    case "queue": {
      const next = args.trim();
      if (!next) return "Usage: /queue <prompt>";
      s.queued.push(next);
      return `Queued for the next turn. (${s.queued.length} queued)`;
    }
    default:
      return null; // any other /word goes to the model
  }
}

async function prompt(params) {
  const s = getSession(params.sessionId);
  if (!s) {
    log("ERROR", "acp_adapter.server", `prompt: session ${params.sessionId} not found`);
    return { stopReason: "refusal" };
  }
  const blocks = Array.isArray(params.prompt) ? params.prompt : [];
  let t = blocks.filter((b) => b?.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n").trim();
  const links = blocks.filter((b) => b?.type === "resource_link" && typeof b.uri === "string").map((b) => b.uri);
  const textOnly = blocks.every((b) => b?.type === "text");
  if (!t && !links.length) return { stopReason: "end_turn" };

  // server.py:1331-1350: /steer on an idle session runs as a normal prompt.
  if (textOnly && t.startsWith("/steer") && !s.turn) {
    const guidance = /^\S+\s*([\s\S]*)$/.exec(t)[1].trim();
    if (guidance) {
      t = s.interrupted ? `${s.interrupted}\n\nUser correction/guidance after interrupt: ${guidance}` : guidance;
      s.interrupted = "";
    }
  }
  if (textOnly && t.startsWith("/")) {
    const said = slashAnswer(s, t);
    if (said !== null) {
      chunk(s.id, said);
      usageUpdate(s);
      return { stopReason: "end_turn" };
    }
  }
  if (s.turn) {
    s.queued.push(t || "[Image attachment]");
    chunk(s.id, `Queued for the next turn. (${s.queued.length} queued)`);
    return { stopReason: "end_turn" };
  }
  return runTurn(s, { text: t, links });
}

// ---- methods ----------------------------------------------------------------------------------------

const NO_REPLY = Symbol("no reply");

const METHODS = {
  initialize(params) {
    log("INFO", "acp_adapter.server", `Initialize from ${params?.clientInfo?.name ?? "unknown"} (protocol v${params?.protocolVersion})`);
    const mode = process.env.FAKE_ACP_INIT;
    if (mode === "exit") {
      process.stderr.write("fake: exit on initialize\n");
      process.exit(1);
    }
    if (mode === "hang") return new Promise(() => {});
    if (mode === "fail") throw new RpcError(-32603, "Internal error", { details: "fake: initialize failed" });
    return structuredClone(SHAPES.initializeResult);
  },

  authenticate: () => ({}),

  "session/new"(params) {
    const s = createSession(typeof params.cwd === "string" ? params.cwd : process.cwd());
    log("INFO", "acp_adapter.server", `New session ${s.id} (cwd=${s.cwd})`);
    setImmediate(() => {
      commandsUpdate(s);
      usageUpdate(s);
    });
    return { _meta: provenance(s), models: modelState(s), modes: modeState(s), sessionId: s.id };
  },

  "session/load"(params) {
    const s = getSession(params.sessionId);
    if (!s) {
      log("WARNING", "acp_adapter.server", `load_session: session ${params.sessionId} not found`);
      return {};
    }
    if (typeof params.cwd === "string" && params.cwd !== s.cwd) {
      s.cwd = params.cwd;
      persist(s);
    }
    log("INFO", "acp_adapter.server", `Loaded session ${s.id}`);
    replay(s);
    setImmediate(() => {
      commandsUpdate(s);
      usageUpdate(s);
    });
    return { _meta: provenance(s), models: modelState(s), modes: modeState(s) };
  },

  "session/fork"(params) {
    const src = getSession(params.sessionId);
    if (!src) {
      log("INFO", "acp_adapter.server", `Forked session ${params.sessionId} -> `);
      return { sessionId: "" };
    }
    const s = createSession(typeof params.cwd === "string" ? params.cwd : src.cwd, src);
    log("INFO", "acp_adapter.server", `Forked session ${src.id} -> ${s.id}`);
    setImmediate(() => commandsUpdate(s));
    return { models: modelState(s), modes: modeState(s), sessionId: s.id };
  },

  "session/list"(params) {
    const want = typeof params.cwd === "string" && params.cwd ? normCwd(params.cwd) : null;
    let files = [];
    try {
      files = readdirSync(STORE).filter((f) => /^[0-9a-f-]{36}\.json$/.test(f));
    } catch {}
    for (const f of files) getSession(f.slice(0, 36));
    const rows = [...sessions.values()]
      .filter((s) => s.history.length > 0 && (!want || normCwd(s.cwd) === want))
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
      .map((s) => ({
        sessionId: s.id,
        cwd: s.cwd,
        title: s.title || s.history.find((m) => m.role === "user" && m.content?.trim())?.content.trim() || basename(s.cwd.replace(/\/+$/, "")) || "New thread",
        updatedAt: s.updatedAt,
      }));
    return { sessions: rows };
  },

  "session/set_model"(params) {
    const s = getSession(params.sessionId);
    const m = MODELS.find((x) => x.modelId === params.modelId);
    if (s && m) {
      s.model = m.modelId;
      persist(s);
      log("INFO", "acp_adapter.server", `Session ${s.id}: model switched to ${m.modelId}`);
    }
    return {};
  },

  "session/set_mode"(params) {
    const s = getSession(params.sessionId);
    if (s && SHAPES.modes.availableModes.some((m) => m.id === params.modeId)) {
      s.mode = params.modeId;
      persist(s);
    }
    return {};
  },

  "session/cancel"(params) {
    const s = getSession(params.sessionId);
    if (s?.turn) {
      s.turn.ctrl.abort();
      log("INFO", "acp_adapter.server", `Cancelled session ${s.id}`);
    }
    return NO_REPLY;
  },

  "session/prompt": prompt,
};

function onMessage(msg) {
  if (!msg || typeof msg !== "object") return;
  if (msg.method === undefined) {
    const done = pendingOut.get(msg.id);
    if (done) done(msg);
    return;
  }
  const hasId = Object.hasOwn(msg, "id");
  const method = Object.hasOwn(METHODS, msg.method) ? METHODS[msg.method] : null;
  if (!method) {
    if (hasId) send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found", data: { method: msg.method } } });
    return;
  }
  Promise.resolve()
    .then(() => method(msg.params || {}))
    .then(
      (result) => {
        if (hasId && result !== NO_REPLY) reply(msg.id, result);
      },
      (err) => {
        if (!hasId) return;
        const error =
          err instanceof RpcError
            ? { code: err.code, message: err.message, data: err.data }
            : { code: -32603, message: "Internal error", data: { details: String(err?.message ?? err) } };
        send({ jsonrpc: "2.0", id: msg.id, error });
      },
    );
}

// ---- stdin ------------------------------------------------------------------------------------------

if (process.env.FAKE_ACP_IGNORE_TERM === "1") process.on("SIGTERM", () => log("INFO", "acp_adapter.entry", "SIGTERM ignored (fake)"));
log("INFO", "acp_adapter.entry", "Starting hermes-agent ACP adapter");

process.stdout.on("error", () => process.exit(0)); // the client went away
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
  buffer += data;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const raw = buffer.slice(0, nl).replace(/\r$/, "");
    buffer = buffer.slice(nl + 1);
    if (!raw.trim()) continue;
    if (process.env.FAKE_ACP_LOG) appendFileSync(process.env.FAKE_ACP_LOG, raw + "\n");
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      log("WARNING", "acp.connection", "Received non-JSON line");
      continue;
    }
    onMessage(msg);
  }
});
process.stdin.on("end", () => {
  log("INFO", "acp_adapter.entry", "stdin closed, shutting down");
  process.stdout.write("", () => process.exit(0));
});
