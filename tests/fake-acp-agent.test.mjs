// K9: drives tests/fixtures/fake-acp-agent.mjs over stdio and checks every prompt row, `--check` and
// `--fail-check`, and load-replay after a restart against the Hermes 0.17.0 shapes recorded in
// docs/spikes/S9/*.jsonl (and tests/fixtures/acp/hermes-0.17.0.json, checked against them here).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const SHAPES = JSON.parse(readFileSync(new URL("./fixtures/acp/hermes-0.17.0.json", import.meta.url), "utf8"));
const S9 = new URL("../docs/spikes/S9/", import.meta.url);
const recorded = (name) => readFileSync(new URL(name, S9), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const K7_SESSION = /^[0-9a-f-]{36}$/;
const STEER_ACK = "\u23E9 Steer queued for the active turn: ";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const txt = (text) => ({ type: "text", text });

/** The structure of a JSON value: object keys, value types, arrays by their first element. */
function shape(v) {
  if (Array.isArray(v)) return v.length ? [shape(v[0])] : [];
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape(v[k])]));
  return v === null ? "null" : typeof v;
}
const without = (o, ...keys) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

/** One fake agent process with a line-level view of its stdout. */
class Agent {
  constructor(args, env) {
    this.msgs = [];
    this.times = [];
    this.bytes = [];
    this.stderr = "";
    this.n = 0;
    this.waiters = new Set();
    this.exitInfo = null;
    this.child = spawn(process.execPath, [FIXTURE, ...args], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const raw = buf.slice(0, i);
        buf = buf.slice(i + 1);
        this.msgs.push(JSON.parse(raw));
        this.times.push(performance.now());
        this.bytes.push(Buffer.byteLength(raw));
      }
      this.wake();
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (d) => (this.stderr += d));
    this.exited = new Promise((resolve) =>
      this.child.on("exit", (code, signal) => {
        this.exitInfo = { code, signal };
        this.wake();
        resolve(this.exitInfo);
      }),
    );
    this.child.stdin.on("error", () => {});
  }
  wake() {
    for (const w of [...this.waiters]) w();
  }
  mark() {
    return this.msgs.length;
  }
  find(pred, from = 0, to = this.msgs.length) {
    for (let i = from; i < to; i++) if (pred(this.msgs[i])) return i;
    return -1;
  }
  /** The first message at index ≥ `from` matching `pred`, as `{msg, index}`. */
  until(pred, from = 0, ms = 5000, what = "a matching message") {
    return new Promise((resolve, reject) => {
      const check = () => {
        const i = this.find(pred, from);
        if (i >= 0) return finish(() => resolve({ msg: this.msgs[i], index: i }));
        if (this.exitInfo) return finish(() => reject(new Error(`agent exited (${JSON.stringify(this.exitInfo)}) before ${what}\n${this.stderr}`)));
      };
      const finish = (f) => {
        clearTimeout(timer);
        this.waiters.delete(check);
        f();
      };
      const timer = setTimeout(() => finish(() => reject(new Error(`timed out after ${ms} ms waiting for ${what}; last: ${JSON.stringify(this.msgs.slice(-3)).slice(0, 2000)}`))), ms);
      this.waiters.add(check);
      check();
    });
  }
  write(msg) {
    this.child.stdin.write(JSON.stringify(msg) + "\n");
  }
  request(method, params) {
    const id = `t:${++this.n}`;
    const from = this.mark();
    this.write({ jsonrpc: "2.0", id, method, params });
    return { id, from };
  }
  response(id, ms = 5000) {
    return this.until((m) => m.id === id && m.method === undefined, 0, ms, `the response to ${id}`);
  }
  async call(method, params, ms) {
    const req = this.request(method, params);
    const { msg, index } = await this.response(req.id, ms);
    return { ...req, msg, index, result: msg.result };
  }
  notify(method, params) {
    this.write({ jsonrpc: "2.0", method, params });
  }
  respond(id, result) {
    this.write({ jsonrpc: "2.0", id, result });
  }
  updates(sessionId, from = 0, to = this.msgs.length) {
    const out = [];
    for (let i = from; i < to; i++) {
      const m = this.msgs[i];
      if (m.method === "session/update" && m.params.sessionId === sessionId) out.push({ ...m.params.update, index: i });
    }
    return out;
  }
  async close() {
    this.child.stdin.end();
    return this.exited;
  }
  kill() {
    if (!this.exitInfo) this.child.kill("SIGKILL");
  }
}

const isUpdate = (sid, kind, extra = () => true) => (m) => m.method === "session/update" && m.params.sessionId === sid && m.params.update.sessionUpdate === kind && extra(m.params.update);
const isChunk = (sid, test) =>
  isUpdate(sid, "agent_message_chunk", (u) => (typeof test === "string" ? u.content.text === test : test.test(u.content.text)));
const isPermission = (sid) => (m) => m.method === "session/request_permission" && m.params.sessionId === sid;
const answerText = (a, sid, from, to) =>
  a
    .updates(sid, from, to)
    .filter((u) => u.sessionUpdate === "agent_message_chunk")
    .map((u) => u.content.text)
    .join("");

/** A started agent in a fresh FAKE_ACP_HOME, initialized as the bridge does it. */
async function boot(t, { args = ["-p", "default", "acp"], env = {}, home } = {}) {
  if (!home) {
    home = await mkdtemp(join(tmpdir(), "fake-acp-"));
    t.after(() => rm(home, { recursive: true, force: true }));
  }
  const a = new Agent(args, { FAKE_ACP_HOME: home, ...env });
  t.after(() => a.kill());
  const init = recorded("01-initialize.jsonl")[0].msg;
  const r = await a.call("initialize", init.params);
  assert.deepEqual(r.result, SHAPES.initializeResult);
  return { a, home };
}

async function newSession(a, cwd) {
  const r = await a.call("session/new", { cwd, mcpServers: [] });
  const sid = r.result.sessionId;
  await a.until(isUpdate(sid, "usage_update"), r.index, 5000, "usage_update after session/new");
  return { sid, ...r };
}

function prompt(a, sessionId, text, extra = []) {
  return a.request("session/prompt", { sessionId, prompt: [txt(text), ...extra] });
}

// ---- --check -------------------------------------------------------------------------------------

test("acp --check prints Hermes's check line; --fail-check fails it; usage errors exit 2", () => {
  for (const args of [["acp", "--check"], ["-p", "work", "acp", "--check"]]) {
    const r = spawnSync(process.execPath, [FIXTURE, ...args], { encoding: "utf8" });
    assert.equal(r.status, 0, args.join(" "));
    assert.equal(r.stdout, "Hermes ACP check OK\n");
    assert.equal(r.stderr, "");
  }
  for (const args of [["--fail-check", "acp", "--check"], ["--fail-check", "-p", "default", "acp", "--check"]]) {
    const r = spawnSync(process.execPath, [FIXTURE, ...args], { encoding: "utf8" });
    assert.equal(r.status, 1, args.join(" "));
    assert.equal(r.stdout, "");
    assert.equal(r.stderr.trim(), "fake: check failed");
  }
  for (const args of [["-p", "default"], ["-p", "Bad Name", "acp"], ["-p", "../x", "acp", "--check"]]) {
    const r = spawnSync(process.execPath, [FIXTURE, ...args], { encoding: "utf8" });
    assert.equal(r.status, 2, args.join(" "));
  }
});

test("a leading --fail-check does not stop the agent from serving ACP", async (t) => {
  await boot(t, { args: ["--fail-check", "-p", "default", "acp"] });
});

// ---- recorded shapes --------------------------------------------------------------------------------

test("the shapes file matches the S9 recordings", () => {
  for (const f of ["01-initialize.jsonl", "cold-start-run2.jsonl", "cold-start-run3.jsonl"]) assert.deepEqual(recorded(f)[1].msg.result, SHAPES.initializeResult, f);
  const created = recorded("02-session-new.jsonl");
  assert.deepEqual(created[1].msg.result.modes, SHAPES.modes);
  const commands = created[2].msg.params.update.availableCommands;
  assert.deepEqual(
    SHAPES.availableCommands.map((c) => c.name),
    ["help", "model", "steer", "queue", "version"],
  );
  for (const c of SHAPES.availableCommands) assert.deepEqual(c, commands.find((r) => r.name === c.name), c.name);
  assert.deepEqual(created[3].msg.params.update, { size: SHAPES.usage.size, used: SHAPES.usage.used, sessionUpdate: "usage_update" });
  assert.equal(sha256(SHAPES.helpText), recorded("05-prompt-help.jsonl")[1].redacted[0].sha256);
  assert.equal(sha256(SHAPES.versionText), recorded("06-prompt-version.jsonl")[1].redacted[0].sha256);
  assert.equal(SHAPES.helpText.length, recorded("05-prompt-help.jsonl")[1].redacted[0].chars);
  assert.ok(SHAPES.helpText.endsWith("Unrecognized /commands are sent to the model as normal messages."));
  // SDK-serialized chunks have the recorded chunk shape.
  const recordedChunk = recorded("05-prompt-help.jsonl")[1].msg.params;
  assert.deepEqual(shape(SHAPES.sdk.thoughtChunk), shape(recordedChunk));
  assert.deepEqual(shape(SHAPES.sdk.userChunk), shape(recordedChunk));
});

// ---- session lifecycle ------------------------------------------------------------------------------

test("initialize, session/new, session/list and session/set_model answer like Hermes", async (t) => {
  const { a, home } = await boot(t);
  assert.match(a.stderr, /\[INFO\] acp_adapter\.server: Initialize from lazuli \(protocol v1\)/);
  const rec = recorded("02-session-new.jsonl");
  const cwd = join(home, "work");
  const r = await a.call("session/new", { ...rec[0].msg.params, cwd });
  const res = r.result;
  assert.deepEqual(shape(res), shape(rec[1].msg.result));
  assert.match(res.sessionId, UUID_V4);
  assert.match(res.sessionId, K7_SESSION);
  assert.deepEqual(res._meta.hermes.sessionProvenance, {
    acpSessionId: res.sessionId,
    currentHermesSessionId: res.sessionId,
    rootHermesSessionId: res.sessionId,
    parentHermesSessionId: null,
    sessionKind: "root",
    compressionDepth: 0,
  });
  assert.deepEqual(res.models, {
    availableModels: [
      { description: "Provider: Fake • current", modelId: "fake:alpha", name: "alpha" },
      { description: "Provider: Fake", modelId: "fake:beta", name: "beta" },
    ],
    currentModelId: "fake:alpha",
  });
  assert.deepEqual(res.modes, rec[1].msg.result.modes);
  // Notifications follow the response: commands, then usage (S9 02).
  const cmds = await a.until(isUpdate(res.sessionId, "available_commands_update"), 0);
  const usage = await a.until(isUpdate(res.sessionId, "usage_update"), 0);
  assert.ok(r.index < cmds.index && cmds.index < usage.index);
  assert.deepEqual(shape(cmds.msg), shape(rec[2].msg));
  assert.deepEqual(cmds.msg.params.update.availableCommands, SHAPES.availableCommands);
  assert.deepEqual(shape(usage.msg), shape(rec[3].msg));
  assert.deepEqual(without(usage.msg.params.update, "used"), { size: 272000, sessionUpdate: "usage_update" });
  // A fresh session is not listed (S9 03: message_count 0).
  const list = recorded("03-session-list.jsonl");
  const l = await a.call("session/list", { ...list[0].msg.params, cwd });
  assert.deepEqual(l.result, list[1].msg.result);
  // set_model answers {} (S9 04) and changes the model.
  const sm = recorded("04-session-set-model.jsonl");
  const s = await a.call("session/set_model", { ...sm[0].msg.params, sessionId: res.sessionId, modelId: "fake:beta" });
  assert.deepEqual(s.result, sm[1].msg.result);
  const s2 = await a.call("session/set_model", { sessionId: res.sessionId, modelId: "nope:x" });
  assert.deepEqual(s2.result, {});
  const ld = await a.call("session/load", { sessionId: res.sessionId, cwd, mcpServers: [] });
  assert.equal(ld.result.models.currentModelId, "fake:beta");
  assert.deepEqual(
    ld.result.models.availableModels.map((m) => m.description),
    ["Provider: Fake", "Provider: Fake • current"],
  );
  assert.deepEqual(shape(ld.result), shape(without(rec[1].msg.result, "sessionId")));
  // Two sessions get two distinct v4 ids.
  const other = await newSession(a, cwd);
  assert.match(other.sid, UUID_V4);
  assert.notEqual(other.sid, res.sessionId);
});

test("/help and /version: one chunk with Hermes's text, usage_update, then end_turn without usage", async (t) => {
  const { a, home } = await boot(t);
  const { sid } = await newSession(a, home);
  for (const [file, text] of [["05-prompt-help.jsonl", SHAPES.helpText], ["06-prompt-version.jsonl", SHAPES.versionText]]) {
    const rec = recorded(file);
    const req = a.request("session/prompt", { ...rec[0].msg.params, sessionId: sid });
    const res = await a.response(req.id);
    const seq = a.msgs.slice(req.from, res.index + 1);
    // ids differ in type (the client's are strings), so compare without them
    assert.deepEqual(seq.map((m) => shape(without(m, "id"))), rec.slice(1).map((r) => shape(without(r.msg, "id"))), file);
    assert.equal(seq[0].params.update.content.text, text);
    assert.equal(sha256(seq[0].params.update.content.text), rec[1].redacted[0].sha256);
    assert.deepEqual(res.msg.result, rec[3].msg.result);
  }
});

// ---- prompt rows ------------------------------------------------------------------------------------

test("other text: a thought, then Echo in 5 chunks over 1 s, usage_update, end_turn, then the title once", async (t) => {
  const { a, home } = await boot(t);
  const { sid } = await newSession(a, home);
  const req = prompt(a, sid, "hello **bold**");
  const res = await a.response(req.id);
  const ups = a.updates(sid, req.from, res.index);
  assert.equal(ups[0].sessionUpdate, "agent_thought_chunk");
  assert.deepEqual(shape(without(ups[0], "index")), shape(SHAPES.sdk.thoughtChunk.update));
  const chunks = ups.filter((u) => u.sessionUpdate === "agent_message_chunk");
  assert.equal(chunks.length, 5);
  assert.equal(chunks.map((c) => c.content.text).join(""), "Echo: hello **bold**");
  for (const c of chunks) assert.deepEqual(shape(without(c, "index")), shape(recorded("05-prompt-help.jsonl")[1].msg.params.update));
  const span = a.times[chunks[4].index] - a.times[ups[0].index];
  assert.ok(span >= 800 && span < 3000, `5 chunks over about 1 s, got ${span} ms`);
  assert.equal(ups.at(-1).sessionUpdate, "usage_update");
  assert.ok(ups.at(-1).index > chunks[4].index);
  assert.deepEqual(shape(res.msg.result), shape(SHAPES.sdk.promptResponse));
  assert.equal(res.msg.result.stopReason, "end_turn");
  assert.equal(res.msg.result.usage.totalTokens, res.msg.result.usage.inputTokens + res.msg.result.usage.outputTokens);
  const info = await a.until(isUpdate(sid, "session_info_update"), req.from);
  assert.ok(info.index > res.index, "the title follows the response");
  assert.deepEqual(shape(info.msg.params), shape(SHAPES.sdk.sessionInfoUpdate));
  assert.ok(info.msg.params.update.title.length > 0);
  assert.equal(info.msg.params.update._meta.hermes.sessionProvenance.acpSessionId, sid);
  // Hermes logs the first 100 characters of the prompt (the bridge rewrites this line).
  assert.ok(a.stderr.includes(`[INFO] acp_adapter.server: Prompt on session ${sid}: hello **bold**\n`));
  // The title is sent once.
  const req2 = prompt(a, sid, "again");
  const res2 = await a.response(req2.id);
  await sleep(200);
  assert.equal(a.find(isUpdate(sid, "session_info_update"), res2.index), -1);
  assert.equal(answerText(a, sid, req2.from, res2.index), "Echo: again");
});

test("@ attachments: each resource_link URI is echoed; a slash text with an attachment goes to the model", async (t) => {
  const { a, home } = await boot(t);
  const { sid } = await newSession(a, home);
  const link = (name) => ({ type: "resource_link", uri: `file:///tmp/lz-assistant-a/${name}`, name });
  let req = prompt(a, sid, "see this", [link("notes.md"), link("sub/plan.md")]);
  let res = await a.response(req.id);
  const said = answerText(a, sid, req.from, res.index);
  assert.ok(said.startsWith("Echo: see this"));
  assert.ok(said.includes("file:///tmp/lz-assistant-a/notes.md"));
  assert.ok(said.includes("file:///tmp/lz-assistant-a/sub/plan.md"));
  req = prompt(a, sid, "/help", [link("notes.md")]);
  res = await a.response(req.id);
  assert.ok(answerText(a, sid, req.from, res.index).startsWith("Echo: /help"));
});

test("tool: tool_call (execute) pending → in_progress → completed after 1.5 s, then an answer", async (t) => {
  const { a, home } = await boot(t);
  const { sid } = await newSession(a, home);
  const req = prompt(a, sid, "tool run ls");
  const res = await a.response(req.id, 8000);
  const ups = a.updates(sid, req.from, res.index);
  const start = ups.find((u) => u.sessionUpdate === "tool_call");
  assert.equal(start.kind, "execute");
  assert.equal(start.status, "pending");
  assert.equal(start.title, "terminal: run ls");
  assert.deepEqual(start.content, [{ content: { text: "$ run ls", type: "text" }, type: "content" }]);
  assert.deepEqual(shape(without(start, "index", "status")), shape(SHAPES.sdk.toolCallStart.update));
  const progress = ups.filter((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === start.toolCallId);
  assert.deepEqual(progress.map((u) => u.status), ["in_progress", "completed"]);
  const done = progress[1];
  assert.deepEqual(shape(without(done, "index")), shape(SHAPES.sdk.toolCallComplete.update));
  assert.ok(done.content[0].content.text.length > 0);
  const took = a.times[done.index] - a.times[start.index];
  assert.ok(took >= 1300 && took < 4000, `completed after about 1.5 s, got ${took} ms`);
  const answer = ups.find((u) => u.sessionUpdate === "agent_message_chunk");
  assert.ok(answer.index > done.index);
  assert.equal(res.msg.result.stopReason, "end_turn");
});

test("edit: edit-approval-1 with a diff and allow_once/deny; allow completes the edit tool with that diff, deny fails it", async (t) => {
  const { a, home } = await boot(t);
  const { sid } = await newSession(a, home);
  const path = join(home, "notes.md");
  let req = prompt(a, sid, "edit notes");
  const start = await a.until(isUpdate(sid, "tool_call"), req.from);
  const tool = start.msg.params.update;
  assert.equal(tool.kind, "edit");
  assert.equal(tool.status, "pending");
  assert.deepEqual(tool.locations, [{ path }]);
  assert.equal(tool.title, `patch (replace): ${path}`);
  assert.deepEqual(shape(without(tool, "status")), shape(SHAPES.sdk.editToolCallStart.update));
  const perm = await a.until(isPermission(sid), req.from);
  assert.ok(perm.index > start.index);
  assert.equal(typeof perm.msg.id, "number");
  // rawInput.arguments are the patch tool's own arguments; the rest is the SDK shape
  const noArgs = (p) => ({ ...p, toolCall: { ...p.toolCall, rawInput: without(p.toolCall.rawInput, "arguments") } });
  assert.deepEqual(shape(noArgs(perm.msg.params)), shape(noArgs(SHAPES.sdk.editPermissionParams)));
  assert.equal(perm.msg.params.toolCall.rawInput.tool, "patch");
  assert.equal(perm.msg.params.toolCall.rawInput.arguments.path, path);
  const call = perm.msg.params.toolCall;
  assert.equal(call.toolCallId, "edit-approval-1");
  assert.equal(call.kind, "edit");
  assert.equal(call.title, `Approve edit: ${path}`);
  assert.deepEqual(perm.msg.params.options, SHAPES.sdk.editPermissionParams.options);
  const diff = call.content[0];
  assert.equal(diff.type, "diff");
  assert.equal(diff.path, path);
  assert.notEqual(diff.oldText, diff.newText);
  a.respond(perm.msg.id, { outcome: { outcome: "selected", optionId: "allow_once" } });
  let res = await a.response(req.id);
  let done = a.updates(sid, perm.index, res.index).find((u) => u.sessionUpdate === "tool_call_update");
  assert.equal(done.toolCallId, tool.toolCallId);
  assert.equal(done.status, "completed");
  assert.equal(done.kind, "edit");
  assert.deepEqual(done.content, [diff]);
  assert.equal(answerText(a, sid, perm.index, res.index), "Edited notes.md.");
  assert.equal(res.msg.result.stopReason, "end_turn");
  // A second edit is edit-approval-2; deny fails the tool without a diff.
  req = prompt(a, sid, "edit notes");
  const perm2 = await a.until(isPermission(sid), req.from);
  assert.equal(perm2.msg.params.toolCall.toolCallId, "edit-approval-2");
  a.respond(perm2.msg.id, { outcome: { outcome: "selected", optionId: "deny" } });
  res = await a.response(req.id);
  done = a.updates(sid, perm2.index, res.index).find((u) => u.sessionUpdate === "tool_call_update");
  assert.equal(done.status, "failed");
  assert.ok(done.content.every((c) => c.type === "content"));
  assert.match(answerText(a, sid, perm2.index, res.index), /not approved/);
});

test("approve: Hermes's five options; the chosen optionId is echoed", async (t) => {
  const { a, home } = await boot(t);
  const { sid } = await newSession(a, home);
  for (const [text, choice] of [["approve one", "allow_once"], ["approve two", "deny_always"], ["approve x", "allow_session"]]) {
    const req = prompt(a, sid, text);
    const perm = await a.until(isPermission(sid), req.from);
    assert.deepEqual(shape(perm.msg.params), shape(SHAPES.sdk.permissionParams));
    assert.deepEqual(perm.msg.params.options, SHAPES.sdk.permissionParams.options);
    const call = perm.msg.params.toolCall;
    assert.match(call.toolCallId, /^perm-check-\d+$/);
    assert.equal(call.kind, "execute");
    assert.equal(call.status, "pending");
    a.respond(perm.msg.id, { outcome: { outcome: "selected", optionId: choice } });
    const res = await a.response(req.id);
    assert.equal(answerText(a, sid, perm.index, res.index), `Chosen option: ${choice}`);
    assert.equal(res.msg.result.stopReason, "end_turn");
  }
});

test("approve2: the same options without allow_always", async (t) => {
  const { a, home } = await boot(t);
  const { sid } = await newSession(a, home);
  const req = prompt(a, sid, "approve2 three");
  const perm = await a.until(isPermission(sid), req.from);
  assert.deepEqual(
    perm.msg.params.options,
    SHAPES.sdk.permissionParams.options.filter((o) => o.optionId !== "allow_always"),
  );
  assert.deepEqual(perm.msg.params.options.map((o) => o.optionId), ["allow_once", "allow_session", "deny", "deny_always"]);
  a.respond(perm.msg.id, { outcome: { outcome: "selected", optionId: "allow_once" } });
  const res = await a.response(req.id);
  assert.equal(answerText(a, sid, perm.index, res.index), "Chosen option: allow_once");
});

test("approve: no answer in time → outcome cancelled; a late answer is ignored", async (t) => {
  const { a, home } = await boot(t, { env: { FAKE_ACP_PERMISSION_MS: "400" } });
  const { sid } = await newSession(a, home);
  const req = prompt(a, sid, "approve four");
  const perm = await a.until(isPermission(sid), req.from);
  const res = await a.response(req.id, 4000);
  assert.equal(answerText(a, sid, perm.index, res.index), "Permission outcome: cancelled");
  assert.equal(res.msg.result.stopReason, "end_turn");
  assert.ok(a.times[res.index] - a.times[perm.index] >= 350);
  a.respond(perm.msg.id, { outcome: { outcome: "selected", optionId: "deny" } });
  const v = prompt(a, sid, "/version");
  const vr = await a.response(v.id);
  assert.equal(answerText(a, sid, v.from, vr.index), SHAPES.versionText);
  assert.equal(a.find((m) => m.method === "session/update" && /Chosen option/.test(m.params.update.content?.text ?? "")), -1);
});

test("approve: Hermes waits (60 s by default); session/cancel ends the turn with cancelled", async (t) => {
  const { a, home } = await boot(t);
  const { sid } = await newSession(a, home);
  const req = prompt(a, sid, "approve wait");
  const perm = await a.until(isPermission(sid), req.from);
  await sleep(1200);
  assert.equal(a.find((m) => m.id === req.id && m.method === undefined), -1, "still waiting after 1.2 s");
  a.notify("session/cancel", { sessionId: sid });
  const res = await a.response(req.id, 2000);
  assert.deepEqual(res.msg.result, { stopReason: "cancelled" });
  assert.equal(answerText(a, sid, perm.index, res.index), "");
});

test("slow: one chunk per second; /steer is acknowledged with Hermes's text and steers the stream; cancel ends it", async (t) => {
  const { a, home } = await boot(t);
  const { sid } = await newSession(a, home);
  const req = prompt(a, sid, "slow");
  const c1 = await a.until(isChunk(sid, "Slow chunk 1/20. "), req.from, 3000);
  const c2 = await a.until(isChunk(sid, "Slow chunk 2/20. "), req.from, 3000);
  const gap = a.times[c2.index] - a.times[c1.index];
  assert.ok(gap >= 700 && gap < 1800, `one chunk per second, got ${gap} ms`);

  const st = prompt(a, sid, "/steer go left");
  const sr = await a.response(st.id);
  const ackAt = a.find(isChunk(sid, `${STEER_ACK}go left`), st.from, sr.index);
  const usageAt = a.find(isUpdate(sid, "usage_update"), ackAt, sr.index);
  assert.ok(ackAt >= 0 && usageAt > ackAt, "ack chunk, then usage_update, then the steer's end_turn");
  assert.deepEqual(sr.msg.result, { stopReason: "end_turn" });
  assert.equal(a.find((m) => m.id === req.id && m.method === undefined), -1, "the slow turn keeps running");
  const steered = await a.until(isChunk(sid, "Steered: go left"), st.from, 2500);
  assert.ok(steered.index > ackAt, "the steered text follows the acknowledgement");

  const long = "x".repeat(100);
  const st2 = prompt(a, sid, `/steer ${long}`);
  const sr2 = await a.response(st2.id);
  assert.ok(a.find(isChunk(sid, `${STEER_ACK}${"x".repeat(80)}...`), st2.from, sr2.index) >= 0, "preview is 80 characters and ...");
  await a.until(isChunk(sid, `Steered: ${long}`), st2.from, 2500);

  // A plain prompt while the turn runs is queued by Hermes and runs after the turn.
  const q = prompt(a, sid, "hello queued");
  const qr = await a.response(q.id);
  assert.equal(answerText(a, sid, q.from, qr.index).includes("Queued for the next turn. (1 queued)"), true);
  assert.deepEqual(qr.msg.result, { stopReason: "end_turn" });

  const cancelAt = a.mark();
  const t0 = performance.now();
  a.notify("session/cancel", { sessionId: sid });
  const res = await a.response(req.id, 5000);
  assert.ok(performance.now() - t0 < 3000, "cancel answers promptly");
  assert.deepEqual(res.msg.result, { stopReason: "cancelled" });
  const after = a.updates(sid, cancelAt, res.index);
  assert.ok(after.filter((u) => u.sessionUpdate === "agent_message_chunk" && /^Slow chunk/.test(u.content.text)).length <= 1);
  const userAt = after.findIndex((u) => u.sessionUpdate === "user_message_chunk" && u.content.text === "hello queued");
  assert.ok(userAt >= 0, "the queued prompt is shown as a user message");
  assert.match(answerText(a, sid, after[userAt].index, res.index), /Echo: hello queued/);
  const endAt = a.mark();
  await sleep(1300);
  assert.equal(a.find(isChunk(sid, /^Slow chunk/), endAt), -1, "no chunks after the cancelled response");
});

test("/steer on an idle session runs as a prompt, and after a cancel it carries the interrupted prompt", async (t) => {
  const { a, home } = await boot(t);
  const { sid } = await newSession(a, home);
  let req = prompt(a, sid, "/steer hi there");
  let res = await a.response(req.id);
  assert.equal(answerText(a, sid, req.from, res.index), "Echo: hi there");
  assert.equal(res.msg.result.stopReason, "end_turn");
  req = prompt(a, sid, "/steer");
  res = await a.response(req.id);
  assert.equal(answerText(a, sid, req.from, res.index), "Usage: /steer <guidance>");
  // cancel a slow turn, then steer: Hermes replays the interrupted prompt with the guidance.
  req = prompt(a, sid, "slow");
  await a.until(isChunk(sid, "Slow chunk 1/20. "), req.from, 3000);
  a.notify("session/cancel", { sessionId: sid });
  await a.response(req.id);
  req = prompt(a, sid, "/steer go right");
  await a.until(isChunk(sid, "Slow chunk 1/20. "), req.from, 3000);
  assert.ok(a.stderr.includes(`Prompt on session ${sid}: slow\n\nUser correction/guidance after interrupt: go right`));
  a.notify("session/cancel", { sessionId: sid });
  res = await a.response(req.id);
  assert.deepEqual(res.msg.result, { stopReason: "cancelled" });
});

test("/queue and /model are answered locally like Hermes", async (t) => {
  const { a, home } = await boot(t);
  const { sid } = await newSession(a, home);
  let req = prompt(a, sid, "/model");
  let res = await a.response(req.id);
  assert.equal(answerText(a, sid, req.from, res.index), "Current model: fake:alpha\nProvider: fake");
  req = prompt(a, sid, "/model fake:beta");
  res = await a.response(req.id);
  assert.equal(answerText(a, sid, req.from, res.index), "Model switched to: fake:beta\nProvider: fake");
  const ld = await a.call("session/load", { sessionId: sid, cwd: home, mcpServers: [] });
  assert.equal(ld.result.models.currentModelId, "fake:beta");
  req = prompt(a, sid, "/queue");
  res = await a.response(req.id);
  assert.equal(answerText(a, sid, req.from, res.index), "Usage: /queue <prompt>");
  assert.deepEqual(res.msg.result, { stopReason: "end_turn" });
});

test("plan: a plan update with three entries, then an answer", async (t) => {
  const { a, home } = await boot(t);
  const { sid } = await newSession(a, home);
  const req = prompt(a, sid, "plan now");
  const res = await a.response(req.id);
  const ups = a.updates(sid, req.from, res.index);
  const plan = ups.find((u) => u.sessionUpdate === "plan");
  assert.deepEqual(shape(without(plan, "index")), shape(SHAPES.sdk.plan.update));
  assert.equal(plan.entries.length, 3);
  for (const e of plan.entries) assert.ok(["pending", "in_progress", "completed"].includes(e.status));
  const answer = ups.find((u) => u.sessionUpdate === "agent_message_chunk");
  assert.ok(answer.index > plan.index);
  assert.equal(res.msg.result.stopReason, "end_turn");
});

test("burst: 2,100 tool items as fast as possible", async (t) => {
  const { a, home } = await boot(t);
  const { sid } = await newSession(a, home);
  const t0 = performance.now();
  const req = prompt(a, sid, "burst");
  const res = await a.response(req.id, 15000);
  const tools = a.updates(sid, req.from, res.index).filter((u) => u.sessionUpdate === "tool_call");
  assert.equal(tools.length, 2100);
  assert.equal(new Set(tools.map((u) => u.toolCallId)).size, 2100);
  for (const u of tools) assert.equal(u.kind, "execute");
  assert.ok(performance.now() - t0 < 10000);
  assert.equal(res.msg.result.stopReason, "end_turn");
});

test("bigdiff: an edit permission carrying a 1 MiB diff", async (t) => {
  const { a, home } = await boot(t);
  const { sid } = await newSession(a, home);
  const req = prompt(a, sid, "bigdiff");
  const perm = await a.until(isPermission(sid), req.from, 8000);
  const call = perm.msg.params.toolCall;
  assert.match(call.toolCallId, /^edit-approval-\d+$/);
  assert.equal(call.content[0].type, "diff");
  assert.ok(call.content[0].newText.length >= 1024 * 1024);
  assert.ok(a.bytes[perm.index] > 1024 * 1024, "the request line is longer than 1 MiB");
  assert.deepEqual(perm.msg.params.options, SHAPES.sdk.editPermissionParams.options);
  a.respond(perm.msg.id, { outcome: { outcome: "selected", optionId: "deny" } });
  const res = await a.response(req.id);
  assert.equal(res.msg.result.stopReason, "end_turn");
});

test("fail: the prompt request returns a JSON-RPC error; the agent keeps serving", async (t) => {
  const { a, home } = await boot(t);
  const { sid } = await newSession(a, home);
  const req = prompt(a, sid, "fail");
  const res = await a.response(req.id);
  assert.equal(res.msg.result, undefined);
  assert.deepEqual(shape(res.msg.error), shape(SHAPES.sdk.internalError));
  assert.equal(res.msg.error.code, -32603);
  assert.equal(res.msg.error.message, "Internal error");
  const v = prompt(a, sid, "hello");
  const vr = await a.response(v.id);
  assert.equal(vr.msg.result.stopReason, "end_turn");
});

test("crash: the process exits 1 without answering", async (t) => {
  const { a, home } = await boot(t);
  const { sid } = await newSession(a, home);
  const req = prompt(a, sid, "crash");
  const exit = await a.exited;
  assert.deepEqual(exit, { code: 1, signal: null });
  assert.equal(a.find((m) => m.id === req.id), -1);
});

test("unknown methods, unknown sessions, idle cancel and non-JSON lines", async (t) => {
  const { a, home } = await boot(t);
  const r = await a.call("session/nope", {});
  assert.deepEqual(r.msg.error, { code: -32601, message: "Method not found", data: { method: "session/nope" } });
  const p = await a.call("session/prompt", { sessionId: randomUUID(), prompt: [txt("hi")] });
  assert.deepEqual(p.result, { stopReason: "refusal" });
  const { sid } = await newSession(a, home);
  const before = a.mark();
  a.notify("session/cancel", { sessionId: sid });
  a.child.stdin.write("not json\n");
  const v = await a.call("session/list", { cwd: home });
  assert.deepEqual(v.result, { sessions: [] });
  assert.equal(a.find((m) => m.method === undefined && m.id === undefined, before), -1, "a notification gets no reply");
});

// ---- persistence ------------------------------------------------------------------------------------

test("sessions persist under FAKE_ACP_HOME: list by cwd, load replays after a restart, fork copies, profiles are separate", async (t) => {
  const { a, home } = await boot(t);
  const cwd = join(home, "work");
  const elsewhere = join(home, "elsewhere");
  const { sid } = await newSession(a, cwd);
  let req = prompt(a, sid, "hello there");
  let res = await a.response(req.id);
  const info = (await a.until(isUpdate(sid, "session_info_update"), req.from)).msg.params.update;
  req = prompt(a, sid, "tool ls");
  await a.response(req.id, 8000);
  req = prompt(a, sid, "edit notes");
  const perm = await a.until(isPermission(sid), req.from);
  a.respond(perm.msg.id, { outcome: { outcome: "selected", optionId: "allow_once" } });
  await a.response(req.id);
  await a.call("session/set_model", { sessionId: sid, modelId: "fake:beta" });
  const other = await newSession(a, elsewhere);
  res = await a.response(prompt(a, other.sid, "other place").id);
  const empty = await newSession(a, cwd);
  assert.deepEqual(await a.close(), { code: 0, signal: null });
  assert.ok(existsSync(join(home, "default", `${sid}.json`)));

  // Restart with the same home.
  const { a: b } = await boot(t, { home });
  let l = await b.call("session/list", { cwd });
  assert.deepEqual(l.result.sessions.map((s) => Object.keys(s)), [["sessionId", "cwd", "title", "updatedAt"]]);
  assert.deepEqual(without(l.result.sessions[0], "updatedAt"), { sessionId: sid, cwd, title: info.title });
  assert.equal(typeof l.result.sessions[0].updatedAt, "string");
  l = await b.call("session/list", { cwd: cwd + "/" });
  assert.deepEqual(l.result.sessions.map((s) => s.sessionId), [sid]);
  l = await b.call("session/list", {});
  assert.deepEqual(l.result.sessions.map((s) => s.sessionId).sort(), [sid, other.sid].sort());
  assert.ok(!l.result.sessions.some((s) => s.sessionId === empty.sid), "an empty session is not listed");

  const load = b.request("session/load", { sessionId: sid, cwd, mcpServers: [] });
  const lr = await b.response(load.id);
  const replayed = b.updates(sid, load.from, lr.index).map((u) => without(u, "index"));
  assert.deepEqual(
    replayed.map((u) => u.sessionUpdate),
    [
      "user_message_chunk",
      "agent_thought_chunk",
      "agent_message_chunk",
      "user_message_chunk",
      "tool_call",
      "tool_call_update",
      "agent_message_chunk",
      "user_message_chunk",
      "tool_call",
      "tool_call_update",
      "agent_message_chunk",
    ],
  );
  assert.equal(replayed[0].content.text, "hello there");
  assert.equal(replayed[2].content.text, "Echo: hello there");
  assert.equal(replayed[3].content.text, "tool ls");
  assert.deepEqual(shape(replayed[4]), shape(SHAPES.sdk.toolCallStart.update), "replayed tool_call has no status");
  assert.equal(replayed[4].title, "terminal: ls");
  assert.deepEqual(shape(replayed[5]), shape(SHAPES.sdk.toolCallComplete.update));
  assert.equal(replayed[5].status, "completed");
  assert.equal(replayed[5].toolCallId, replayed[4].toolCallId);
  assert.equal(replayed[7].content.text, "edit notes");
  assert.deepEqual(shape(replayed[8]), shape(SHAPES.sdk.editToolCallStart.update));
  assert.deepEqual(replayed[8].locations, [{ path: join(cwd, "notes.md") }]);
  assert.deepEqual(shape(replayed[9]), shape(SHAPES.sdk.editToolCallComplete.update));
  assert.ok(replayed[9].content.every((c) => c.type === "content"), "a replayed edit carries no diff");
  assert.equal(replayed[10].content.text, "Edited notes.md.");
  assert.deepEqual(Object.keys(lr.msg.result), ["_meta", "models", "modes"]);
  assert.equal(lr.msg.result.models.currentModelId, "fake:beta");
  await b.until(isUpdate(sid, "available_commands_update"), lr.index);
  await b.until(isUpdate(sid, "usage_update"), lr.index);

  // Unknown ids answer like Hermes (S9 08, 09).
  const unk = recorded("09-session-load-unknown.jsonl");
  const ur = b.request("session/load", { ...unk[0].msg.params, cwd });
  const urr = await b.response(ur.id);
  assert.deepEqual(urr.msg.result, unk[1].msg.result);
  await sleep(300);
  assert.equal(b.find((m) => m.method === "session/update" && m.params.sessionId === unk[0].msg.params.sessionId), -1);
  const fu = await b.call("session/fork", { sessionId: randomUUID(), cwd, mcpServers: [] });
  assert.deepEqual(fu.result, { sessionId: "" });

  // Fork copies the history into a new session; only available_commands_update follows.
  const forkRec = recorded("08-session-fork.jsonl");
  const fk = await b.call("session/fork", { ...forkRec[0].msg.params, sessionId: sid, cwd });
  assert.deepEqual(shape(fk.result), shape(forkRec[1].msg.result));
  const forked = fk.result.sessionId;
  assert.match(forked, UUID_V4);
  assert.notEqual(forked, sid);
  assert.equal(fk.result.models.currentModelId, "fake:beta");
  const fc = await b.until(isUpdate(forked, "available_commands_update"), fk.index);
  assert.deepEqual(shape(fc.msg), shape(forkRec[2].msg));
  await sleep(300);
  assert.equal(b.find(isUpdate(forked, "usage_update"), fk.index), -1);
  const fl = b.request("session/load", { sessionId: forked, cwd, mcpServers: [] });
  const flr = await b.response(fl.id);
  const texts = (list) => list.filter((u) => u.content?.text !== undefined && !Array.isArray(u.content)).map((u) => `${u.sessionUpdate}:${u.content.text}`);
  assert.deepEqual(texts(b.updates(forked, fl.from, flr.index)), texts(replayed));
  assert.deepEqual(await b.close(), { code: 0, signal: null });

  // Another profile keeps its own store.
  const { a: c } = await boot(t, { home, args: ["-p", "work", "acp"] });
  assert.deepEqual((await c.call("session/list", {})).result, { sessions: [] });
  assert.deepEqual((await c.call("session/load", { sessionId: sid, cwd, mcpServers: [] })).result, {});
});

// ---- test knobs used by the bridge tests ------------------------------------------------------------

test("FAKE_ACP_INIT fail, hang and exit", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "fake-acp-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const init = recorded("01-initialize.jsonl")[0].msg.params;
  const fail = new Agent(["-p", "default", "acp"], { FAKE_ACP_HOME: home, FAKE_ACP_INIT: "fail" });
  t.after(() => fail.kill());
  const fr = await fail.call("initialize", init);
  assert.equal(fr.msg.error.code, -32603);
  const hang = new Agent(["-p", "default", "acp"], { FAKE_ACP_HOME: home, FAKE_ACP_INIT: "hang" });
  t.after(() => hang.kill());
  const hr = hang.request("initialize", init);
  await sleep(500);
  assert.equal(hang.find((m) => m.id === hr.id), -1);
  assert.equal(hang.exitInfo, null);
  const exit = new Agent(["-p", "default", "acp"], { FAKE_ACP_HOME: home, FAKE_ACP_INIT: "exit" });
  t.after(() => exit.kill());
  exit.request("initialize", init);
  assert.deepEqual(await exit.exited, { code: 1, signal: null });
});

test("FAKE_ACP_LOG records received lines; SIGTERM ends the agent unless FAKE_ACP_IGNORE_TERM=1", async (t) => {
  const { a, home } = await boot(t);
  const logFile = join(home, "in.log");
  const { a: b } = await boot(t, { home, env: { FAKE_ACP_LOG: logFile, FAKE_ACP_IGNORE_TERM: "1" } });
  b.notify("session/cancel", { sessionId: randomUUID() });
  await b.call("session/list", {});
  const lines = readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(lines.map((m) => m.method), ["initialize", "session/cancel", "session/list"]);
  b.child.kill("SIGTERM");
  await sleep(300);
  assert.equal(b.exitInfo, null, "SIGTERM ignored");
  b.child.kill("SIGKILL");
  assert.equal((await b.exited).signal, "SIGKILL");
  a.child.kill("SIGTERM");
  const term = await a.exited;
  assert.ok(term.signal === "SIGTERM" || term.code === 143, JSON.stringify(term));
});
