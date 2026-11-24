#!/usr/bin/env node
// lazuli's Assistant bridge (plan K3; spikes S8, S9): one per Hermes profile, started by the mod with
//   hc run --bg --json --no-parent --no-notify --cwd <folder> --label lazuli.assistant=<profile> -- <abs node> \
//     <H>/mods/lazuli/bin/acp-bridge.mjs --profile <name> --cwd <abs folder> --discovery <abs>.json \
//     --log <abs>.log --herdr-pid <pid> --idle-min 30 --agent -- <agent argv…>
// It runs the agent (`<abs hermes> -p <profile> acp`) in a process group of its own, sends `initialize`
// once and keeps the answer, then serves line JSON on 127.0.0.1 to clients holding the token from the
// discovery file (0600, in a 0700 folder; written only after `initialize` succeeded, with the agent argv so the mod
// reuses only a bridge that runs the agent it would start):
// - `{op:"stream", token, since, client, turns?}`: `hello` (with each running prompt's start seq and blocks), the
//   records after `since` (or `gap`; with `since` null and `turns`, the records of the turns still running instead),
//   then every agent line as `{seq, at, msg}`; events `ping` (after 10 s of silence), `replaced`, `dropped`,
//   `agent-error {text}` (a `❌`/`[ERROR]` line on the agent's stderr: Hermes ends a failed turn with `end_turn` and
//   no message), `agent-exit`, `bye`. One subscriber: the newest wins.
// - `{op:"send", token, msg}`: msg to the agent's stdin, `{ok:true}` or `{ok:false, error:{code}}`, close.
// - `{op:"shutdown", token}`: cancel running prompts and wait up to 3 s, SIGTERM the agent group, SIGKILL it
//   2 s later (5 s after a cancel), exit 0.
// SIGHUP (`hc kill`), SIGTERM, SIGINT and the Herdr pid going away take the fast path instead: cancel
// without waiting, SIGTERM, SIGKILL 300 ms later, exit within 400 ms (`hc kill` escalates to SIGKILL
// within 1 s, S8). It exits by itself after `--idle-min` minutes idle (no send, no agent line, nothing in
// flight or pending), and with code 1 when the agent exits (no respawn). The log holds method names, ids,
// sizes and the agent's stderr (prompt text cut out), never the token or message bodies.
//
// Exit codes: 0 after a shutdown, a signal, Herdr gone or idle; 1 when the agent exits or the start fails
// (the discovery file then holds `{version, pid, error:{code: agent-exit|init-failed|init-timeout, detail}}`);
// 2 for bad arguments.

import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute } from "node:path";
import * as wire from "../core/acp-wire.js";

const BRIDGE_VERSION = 1;
const LOG_MAX_BYTES = 5 * 1024 * 1024;
const LOG_LINE_MAX = 2000;
const DETAIL_MAX = 300;
const FIRST_LINE_MAX = wire.MAX_LINE_BYTES + 65536;
const SUB_BACKLOG_MAX = 32 * 1024 * 1024;
const HERDR_POLL_MS = 1000;
const CANCEL_WAIT_MS = 3000;
const KILL_AFTER_MS = 2000;
const KILL_AFTER_CANCEL_MS = 5000;
const FAST_KILL_MS = 300;
const FAST_EXIT_MS = 380;
const STDOUT_DRAIN_MS = 500;
/** A refused or answered connection is destroyed this long after its reply, so a client that never closes its side
 *  does not keep a half-open socket (the server is allowHalfOpen for streams). */
const REPLY_LINGER_MS = 1000;
/** The `turn` of a ring record that belongs to every running turn (an `agent-error`: stderr names no session). */
const ANY_TURN = "*";

// The terminal may be gone (hc kill closes it): writing to it must never crash the bridge.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const reason = (e) => e?.code || e?.message || String(e);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

// Arguments.

const KEYS = new Set(["profile", "cwd", "discovery", "log", "herdr-pid", "idle-min"]);

function parseArgs(argv) {
  const dd = argv.indexOf("--");
  if (dd < 0) return { error: "missing -- <agent argv>" };
  const head = argv.slice(0, dd);
  const agent = argv.slice(dd + 1);
  const o = {};
  for (let i = 0; i < head.length; i++) {
    const k = head[i];
    if (k === "--agent") continue;
    if (!k.startsWith("--") || !KEYS.has(k.slice(2)) || head[i + 1] === undefined) return { error: `bad argument ${k}` };
    o[k.slice(2)] = head[++i];
  }
  const discovery = typeof o.discovery === "string" && isAbsolute(o.discovery) ? o.discovery : null;
  const fail = (error) => ({ error, discovery });
  if (!discovery) return fail("--discovery must be an absolute path");
  if (typeof o.log !== "string" || !isAbsolute(o.log)) return fail("--log must be an absolute path");
  if (typeof o.profile !== "string" || o.profile === "") return fail("--profile is required");
  if (typeof o.cwd !== "string" || !isAbsolute(o.cwd)) return fail("--cwd must be an absolute path");
  try {
    if (!fs.statSync(o.cwd).isDirectory()) return fail("--cwd is not a folder");
  } catch (e) {
    return fail(`--cwd: ${reason(e)}`);
  }
  const herdrPid = Number(o["herdr-pid"]);
  if (!Number.isInteger(herdrPid) || herdrPid <= 0) return fail("--herdr-pid must be a pid");
  const idleMin = o["idle-min"] === undefined ? wire.IDLE_MIN : Number(o["idle-min"]);
  if (!Number.isFinite(idleMin) || idleMin <= 0) return fail("--idle-min must be a positive number");
  if (agent.length === 0 || agent[0] === "") return fail("missing the agent argv after --");
  return { profile: o.profile, cwd: o.cwd, discovery, log: o.log, herdrPid, idleMs: idleMin * 60000, agent };
}

/** Creates the folder 0700, and makes an existing one 0700. */
function privateDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
}

/** Writes the discovery file through a 0600 temp file and a rename. */
function writeDiscoveryFile(path, value) {
  const tmp = `${path}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, path);
}

const args = parseArgs(process.argv.slice(2));
if (args.error) {
  process.stderr.write(`acp-bridge: ${args.error}\n`);
  if (args.discovery) {
    try {
      privateDir(dirname(args.discovery));
      writeDiscoveryFile(args.discovery, { version: wire.DISCOVERY_VERSION, pid: process.pid, error: { code: "init-failed", detail: `usage: ${args.error}` } });
    } catch {}
  }
  process.exit(2);
}

const { profile: PROFILE, cwd: CWD, discovery: DISCOVERY, log: LOG, herdrPid: HERDR_PID, idleMs: IDLE_MS } = args;
const STARTED = Date.now();
const TOKEN = randomBytes(32).toString("hex");
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest();
const ids = wire.createIds("b");
const INIT_ID = ids.next();

// The log: 0600, 5 MiB with one rotation.

let logFd = null;
let logSize = 0;

function openLog() {
  logFd = fs.openSync(LOG, "a", 0o600);
  fs.fchmodSync(logFd, 0o600);
  logSize = fs.fstatSync(logFd).size;
}

function log(text) {
  if (logFd === null) return;
  const line = `${new Date().toISOString()} ${text}\n`;
  const bytes = Buffer.byteLength(line);
  try {
    if (logSize > 0 && logSize + bytes > LOG_MAX_BYTES) {
      fs.closeSync(logFd);
      logFd = null;
      fs.renameSync(LOG, `${LOG}.1`);
      openLog();
    }
    fs.writeSync(logFd, line);
    logSize += bytes;
  } catch {}
}

try {
  privateDir(dirname(DISCOVERY));
  privateDir(dirname(LOG));
  openLog();
} catch (e) {
  process.stderr.write(`acp-bridge: cannot prepare ${dirname(DISCOVERY)}: ${reason(e)}\n`);
  try {
    writeDiscoveryFile(DISCOVERY, { version: wire.DISCOVERY_VERSION, pid: process.pid, error: { code: "init-failed", detail: `files: ${reason(e)}` } });
  } catch {}
  process.exit(1);
}

/** Deletes the discovery file when it still names this bridge (a newer bridge may have replaced it). */
function removeDiscovery() {
  try {
    const d = JSON.parse(fs.readFileSync(DISCOVERY, "utf8"));
    if (d?.pid !== process.pid) return;
    fs.unlinkSync(DISCOVERY);
    log("discovery deleted");
  } catch {}
}

log(`start pid ${process.pid} profile ${PROFILE} herdr-pid ${HERDR_PID} idle ${IDLE_MS} ms agent ${args.agent[0]}`);
process.stdout.write(`lazuli acp-bridge: profile ${PROFILE}, pid ${process.pid}\n`);

// State.

const tracker = wire.createTracker(STARTED);
const promptLengths = new Map(); // sessionId → characters of the last prompt forwarded
let initDone = false;
let initResult = null;
let server = null;
let port = 0;
let lastSeq = 0;
const ring = [];
let ringHead = 0;
let ringBytes = 0;
let sub = null; // the stream subscriber
let subLastWrite = 0;
let stopping = null; // {reason, code, at}
let fastStarted = false;
let byeSent = false;
let finished = false;
let agent = null;
let agentPid = 0;
let agentAlive = false;
let lastStderr = "";

// Stopping. Signal handlers come first: a SIGHUP while the agent starts must not orphan it.

function signalAgent(sig) {
  // The detached child pins the group ID until Node reaps it and emits "exit". After that,
  // even a group with the same ID need not be ours.
  if (!agentAlive) return;
  try {
    process.kill(-agentPid, sig);
    log(`${sig} to agent group ${agentPid}`);
  } catch (e) {
    if (e.code !== "ESRCH") log(`${sig} to agent group failed: ${reason(e)}`);
  }
}

function writeAgent(msg) {
  if (!agentAlive || !agent?.stdin?.writable) return false;
  agent.stdin.write(`${JSON.stringify(msg)}\n`);
  return true;
}

function toSub(buf) {
  if (!sub) return;
  if (sub.writableLength > SUB_BACKLOG_MAX) {
    log(`stream subscriber ${sub.lazuliId} too slow (${sub.writableLength} bytes queued): dropped`);
    sub.destroy();
    sub = null;
    return;
  }
  sub.write(buf);
  subLastWrite = Date.now();
}

const eventLine = (ev, fields = {}) => Buffer.from(`${JSON.stringify({ ev, ...fields, at: Date.now() })}\n`);

function bye(why) {
  if (byeSent) return;
  byeSent = true;
  toSub(eventLine("bye", { reason: why }));
  log(`bye (${why})`);
}

function closeServer() {
  if (!server) return;
  server.close();
  server = null;
}

/** Ends the process after the subscriber's last bytes are flushed, or at `deadline`. */
async function finish(deadline) {
  if (finished) return;
  finished = true;
  const s = sub;
  if (s && !s.destroyed) {
    const flushed = new Promise((r) => {
      s.once("finish", r);
      s.once("close", r);
    });
    s.end();
    await Promise.race([flushed, sleep(Math.max(0, deadline - Date.now()))]);
  }
  log(`exit ${stopping.code} (${stopping.reason}), ${Date.now() - stopping.at} ms after the stop began`);
  try {
    if (logFd !== null) fs.closeSync(logFd);
  } catch {}
  process.exit(stopping.code);
}

/** Polls `test` every 10 ms until it holds or `ms` pass. */
async function waitUntil(test, ms) {
  const end = Date.now() + ms;
  while (!test() && Date.now() < end) await sleep(10);
  return test();
}

/** Starts stopping once: discovery deleted, no new clients, running prompts cancelled. */
function beginStop(why, code) {
  if (stopping) return false;
  stopping = { reason: why, code, at: Date.now() };
  const sessions = tracker.runningSessions();
  log(`stop (${why}); running ${tracker.running().length}, pending ${tracker.pending().length}`);
  removeDiscovery();
  closeServer();
  for (const sessionId of sessions) if (writeAgent(wire.sessionCancel(sessionId))) log(`session/cancel ${sessionId}`);
  stopping.cancelled = sessions.length > 0;
  return true;
}

/** `{op:"shutdown"}` and the idle exit: wait for cancelled prompts, then SIGTERM, then SIGKILL. */
async function gracefulStop(why) {
  if (!beginStop(why, 0)) return;
  const { cancelled } = stopping;
  if (cancelled) {
    const done = await waitUntil(() => fastStarted || tracker.running().length === 0 || !agentAlive, CANCEL_WAIT_MS);
    log(`cancel wait ended after ${Date.now() - stopping.at} ms (${done ? "answered" : "unanswered"})`);
  }
  if (fastStarted) return;
  bye(why);
  signalAgent("SIGTERM");
  await waitUntil(() => fastStarted || !agentAlive, cancelled ? KILL_AFTER_CANCEL_MS : KILL_AFTER_MS);
  if (fastStarted) return;
  if (agentAlive) {
    signalAgent("SIGKILL");
    await waitUntil(() => fastStarted || !agentAlive, 500);
    if (fastStarted) return;
  }
  await finish(Date.now() + 200);
}

/** Signals and Herdr gone: cancel without waiting, SIGTERM, SIGKILL after 300 ms, exit within 400 ms. Also
 *  cuts a graceful stop short. */
async function fastStop(why) {
  if (fastStarted || finished) return;
  fastStarted = true;
  beginStop(why, 0);
  const t0 = Date.now();
  bye(stopping.reason);
  signalAgent("SIGTERM");
  const killTimer = setTimeout(() => signalAgent("SIGKILL"), FAST_KILL_MS);
  await waitUntil(() => !agentAlive, FAST_EXIT_MS - 40);
  clearTimeout(killTimer);
  await finish(t0 + FAST_EXIT_MS);
}

/** A start that failed: the discovery file names the error, the agent group is killed, exit 1. */
function failStart(code, detail) {
  if (stopping) return;
  stopping = { reason: code, code: 1, at: Date.now() };
  const text = cut(String(detail), DETAIL_MAX);
  log(`start failed: ${code}: ${text}`);
  try {
    writeDiscoveryFile(DISCOVERY, { version: wire.DISCOVERY_VERSION, pid: process.pid, error: { code, detail: text } });
  } catch (e) {
    log(`cannot write the discovery file: ${reason(e)}`);
  }
  signalAgent("SIGKILL");
  closeServer();
  finish(Date.now());
}

for (const sig of ["SIGHUP", "SIGTERM", "SIGINT"])
  process.on(sig, () => {
    log(`signal ${sig}`);
    if (!initDone && !stopping) {
      stopping = { reason: "signal", code: 0, at: Date.now() };
      signalAgent("SIGKILL");
      removeDiscovery();
      finish(Date.now());
      return;
    }
    fastStop("signal");
  });

process.on("uncaughtException", (e) => {
  log(`uncaught: ${cut(String(e?.stack ?? e), LOG_LINE_MAX)}`);
  signalAgent("SIGKILL");
  removeDiscovery();
  try {
    if (logFd !== null) fs.closeSync(logFd);
  } catch {}
  process.exit(1);
});

// The agent.

function agentEnv() {
  const env = { ...process.env };
  env.PATH = wire.agentPath(env.PATH, env.HOME || homedir());
  return env;
}

try {
  agent = spawn(args.agent[0], args.agent.slice(1), { cwd: CWD, env: agentEnv(), stdio: ["pipe", "pipe", "pipe"], detached: true });
} catch (e) {
  failStart("agent-exit", `spawn: ${reason(e)}`);
}

let outputClosed = null; // both agent pipes closed: its last lines and stderr are in
if (agent) {
  agentPid = agent.pid ?? 0;
  agentAlive = Boolean(agentPid);
  outputClosed = Promise.all([new Promise((r) => agent.stdout.once("close", r)), new Promise((r) => agent.stderr.once("close", r))]);
  log(agentPid ? `agent pid ${agentPid} (own process group)` : "agent did not start");

  agent.on("error", (e) => {
    if (agent.pid) {
      log(`agent error: ${reason(e)}`);
      return;
    }
    agentAlive = false;
    failStart("agent-exit", `spawn: ${reason(e)}`);
  });
  agent.stdin.on("error", (e) => log(`agent stdin: ${reason(e)}`));
  agent.on("exit", (code, signal) => onAgentExit(code, signal));

  const stderr = wire.createStderrFilter({ promptLength: (sessionId) => promptLengths.get(sessionId) ?? null });
  const logStderr = (lines) => {
    for (const l of lines) {
      if (l.trim() === "") continue;
      lastStderr = cut(l, DETAIL_MAX);
      log(`agent stderr: ${cut(l, LOG_LINE_MAX)}`);
      // An error line becomes an `agent-error` record (the filtered line: never a prompt preview).
      const text = initDone ? wire.agentErrorText(l) : null;
      if (text) {
        const seq = ++lastSeq;
        pushRecord(seq, Buffer.from(`${JSON.stringify({ seq, at: Date.now(), ev: "agent-error", text })}\n`), tracker.runningSessions().length ? ANY_TURN : null);
      }
    }
  };
  agent.stderr.setEncoding("utf8");
  agent.stderr.on("data", (text) => logStderr(stderr.push(text)));
  agent.stderr.on("end", () => logStderr(stderr.end()));

  // Agent stdout: lines of at most MAX_LINE_BYTES; a longer one becomes a `dropped` record.
  let parts = [];
  let partLen = 0;
  let dropping = false;
  agent.stdout.on("data", (chunk) => {
    let start = 0;
    for (;;) {
      const i = chunk.indexOf(10, start);
      if (i < 0) {
        const rest = chunk.length - start;
        if (rest > 0) {
          partLen += rest;
          if (!dropping && partLen > wire.MAX_LINE_BYTES) {
            dropping = true;
            parts = [];
          } else if (!dropping) parts.push(chunk.subarray(start));
        }
        return;
      }
      const seg = chunk.subarray(start, i);
      const total = partLen + seg.length;
      if (dropping || total > wire.MAX_LINE_BYTES) {
        const seq = ++lastSeq;
        const now = Date.now();
        tracker.touch(now);
        log(`agent line of ${total} bytes dropped (over ${wire.MAX_LINE_BYTES})`);
        pushRecord(seq, Buffer.from(`${JSON.stringify({ seq, at: now, ev: "dropped", bytes: total })}\n`));
      } else if (total > 0) {
        onAgentLine(parts.length ? Buffer.concat([...parts, seg]) : seg);
      }
      parts = [];
      partLen = 0;
      dropping = false;
      start = i + 1;
    }
  });

  if (agentAlive) {
    writeAgent(wire.initialize(INIT_ID, BRIDGE_VERSION));
    log("initialize sent");
  }
}

const initTimer = setTimeout(() => {
  if (!initDone) failStart("init-timeout", `no initialize answer in ${wire.INIT_TIMEOUT_MS} ms`);
}, wire.INIT_TIMEOUT_MS);

/** One complete agent line. Every line counts as activity for the idle rule, even one that is skipped. */
function onAgentLine(buf) {
  const now = Date.now();
  tracker.touch(now);
  let msg;
  try {
    msg = JSON.parse(buf.toString("utf8"));
  } catch {
    log(`agent: skipped a non-JSON line of ${buf.length} bytes`);
    return;
  }
  if (!isObj(msg)) {
    log(`agent: skipped a line of ${buf.length} bytes that is not a JSON object`);
    return;
  }
  if (!initDone && msg.id === INIT_ID && msg.method === undefined) {
    onInit(msg, now);
    return;
  }
  const seq = ++lastSeq;
  const c = tracker.fromAgent(msg, now, seq);
  logMessage("agent →", c, buf.length);
  pushRecord(seq, Buffer.concat([Buffer.from(`{"seq":${seq},"at":${now},"msg":`), buf, Buffer.from("}\n")]), tracker.turnRecord(c) ? c.sessionId : null);
}

function logMessage(dir, c, bytes) {
  const what =
    c.kind === "request"
      ? `request ${c.method} id ${JSON.stringify(c.id)}`
      : c.kind === "update"
        ? `update ${c.updateKind ?? "?"}`
        : c.kind === "notification"
          ? `notification ${c.method}`
          : c.kind === "result"
            ? `result id ${JSON.stringify(c.id)}`
            : c.kind === "error"
              ? `error id ${JSON.stringify(c.id)} code ${c.error.code}`
              : "invalid message";
  const session = c.sessionId ? ` session ${c.sessionId}` : "";
  log(`${dir} ${what}${session} (${bytes} B)`);
}

/** A record into the ring and to the subscriber. `turn`: the session whose running turn it belongs to, or null. */
function pushRecord(seq, buf, turn = null) {
  ring.push({ seq, buf, turn });
  ringBytes += buf.length;
  while ((ring.length - ringHead > wire.RING_RECORDS || ringBytes > wire.RING_BYTES) && ring.length - ringHead > 1) {
    ringBytes -= ring[ringHead].buf.length;
    ring[ringHead++] = null;
  }
  if (ringHead > 1024 && ringHead * 2 > ring.length) {
    ring.splice(0, ringHead);
    ringHead = 0;
  }
  toSub(buf);
}

function onInit(msg, now) {
  clearTimeout(initTimer);
  const c = wire.classify(msg);
  if (c.kind !== "result" || !isObj(c.result)) {
    failStart("init-failed", c.kind === "error" ? `rpc ${c.error.code}` : "initialize answered without a result");
    return;
  }
  initDone = true;
  initResult = c.result;
  tracker.touch(now);
  log(`initialize answered in ${now - STARTED} ms`);
  // allowHalfOpen: a client that ends its writing side still gets its reply, and a stream stays open.
  server = net.createServer({ allowHalfOpen: true }, onConnection);
  server.on("error", (e) => failStart("init-failed", `listen: ${reason(e)}`));
  server.listen(0, "127.0.0.1", () => {
    if (stopping) return;
    port = server.address().port;
    try {
      writeDiscoveryFile(DISCOVERY, {
        version: wire.DISCOVERY_VERSION,
        pid: process.pid,
        agentPid,
        port,
        token: TOKEN,
        profile: PROFILE,
        cwd: CWD,
        herdrPid: HERDR_PID,
        startedAt: STARTED,
        argv: args.agent,
      });
    } catch (e) {
      failStart("init-failed", `discovery: ${reason(e)}`);
      return;
    }
    log(`listening on 127.0.0.1:${port}; discovery written`);
    process.stdout.write(`lazuli acp-bridge: ready on 127.0.0.1:${port}\n`);
  });
}

async function onAgentExit(code, signal) {
  agentAlive = false;
  log(`agent exit code ${code} signal ${signal}`);
  if (stopping) return;
  // Its last lines and stderr first.
  await Promise.race([outputClosed, sleep(STDOUT_DRAIN_MS)]);
  if (stopping) return;
  if (!initDone) {
    failStart("agent-exit", `exit code ${code} signal ${signal}${lastStderr ? `: ${lastStderr}` : ""}`);
    return;
  }
  beginStop("agent-exit", 1);
  tracker.clear();
  toSub(eventLine("agent-exit", { code, signal }));
  bye("agent-exit");
  await finish(Date.now() + 200);
}

// Clients.

let connSeq = 0;

function tokenOk(t) {
  if (typeof t !== "string") return false;
  return timingSafeEqual(createHash("sha256").update(t).digest(), TOKEN_HASH);
}

function reply(sock, value) {
  sock.end(`${JSON.stringify(value)}\n`);
  setTimeout(() => sock.destroy(), REPLY_LINGER_MS).unref();
}
const refuse = (sock, code) => reply(sock, { ok: false, error: { code } });

function onConnection(sock) {
  const id = ++connSeq;
  sock.lazuliId = id;
  sock.setNoDelay(true);
  sock.on("error", (e) => log(`conn ${id}: ${reason(e)}`));
  let parts = [];
  let len = 0;
  let first = true;
  let tokenSeen = false; // a valid token at the head of a first line still being read (wire.leadingToken)
  let ignored = false;
  const authTimer = setTimeout(() => {
    if (!first) return;
    first = false;
    log(`conn ${id}: no first line in ${wire.AUTH_MS} ms`);
    refuse(sock, "auth");
  }, wire.AUTH_MS);
  sock.on("close", () => clearTimeout(authTimer));
  sock.on("data", (chunk) => {
    if (!first) {
      if (!ignored) {
        ignored = true;
        log(`conn ${id}: data after the first line ignored`);
      }
      return;
    }
    const i = chunk.indexOf(10);
    if (i < 0) {
      parts.push(chunk);
      len += chunk.length;
      if (len > FIRST_LINE_MAX) {
        first = false;
        clearTimeout(authTimer);
        log(`conn ${id}: first line over ${FIRST_LINE_MAX} bytes`);
        refuse(sock, "too-large");
      } else if (!tokenSeen && len > wire.PRE_AUTH_BYTES) {
        // Only an authenticated line may grow past PRE_AUTH_BYTES (a long `send`): its token comes first.
        const token = wire.leadingToken(Buffer.concat(parts).subarray(0, 512).toString("latin1"));
        if (token !== null && tokenOk(token)) tokenSeen = true;
        else {
          first = false;
          parts = [];
          clearTimeout(authTimer);
          log(`conn ${id}: no token in the first ${wire.PRE_AUTH_BYTES} bytes`);
          refuse(sock, "auth");
        }
      }
      return;
    }
    first = false;
    clearTimeout(authTimer);
    const line = Buffer.concat([...parts, chunk.subarray(0, i)]);
    parts = [];
    if (line.length > FIRST_LINE_MAX) {
      log(`conn ${id}: first line over ${FIRST_LINE_MAX} bytes`);
      refuse(sock, "too-large");
      return;
    }
    onFirstLine(sock, id, line);
  });
}

function onFirstLine(sock, id, line) {
  let req = null;
  try {
    req = JSON.parse(line.toString("utf8"));
  } catch {}
  if (!isObj(req) || !tokenOk(req.token)) {
    log(`conn ${id}: refused (auth)`);
    refuse(sock, "auth");
    return;
  }
  if (req.op === "stream") return onStream(sock, id, req);
  if (req.op === "send") return onSend(sock, id, req.msg);
  if (req.op === "shutdown") {
    log(`conn ${id}: shutdown requested`);
    reply(sock, { ok: true });
    gracefulStop("shutdown");
    return;
  }
  log(`conn ${id}: unknown op`);
  refuse(sock, "bad-request");
}

function onStream(sock, id, req) {
  if (stopping) {
    sock.destroy();
    return;
  }
  if (sub) {
    log(`stream ${sub.lazuliId} replaced by ${id}`);
    const old = sub;
    sub = null;
    old.end(eventLine("replaced"));
  }
  sub = sock;
  const since = Number.isInteger(req.since) && req.since >= 0 ? req.since : null;
  const client = typeof req.client === "string" ? cut(req.client.replace(/[^\w.:-]/g, "?"), 64) : "?";
  sock.on("close", () => {
    if (sub === sock) sub = null;
    log(`stream ${id} closed`);
  });
  const hello = {
    ev: "hello",
    seq: lastSeq,
    bridge: { pid: process.pid, agentPid, version: BRIDGE_VERSION, profile: PROFILE, cwd: CWD, startedAt: STARTED },
    agent: initResult,
    running: tracker.running().map((r) => ({ id: r.id, sessionId: r.sessionId, at: r.at, seq: r.seq, prompt: r.prompt })),
    pending: tracker.pending().map((p) => ({ id: p.id, method: p.method, sessionId: p.sessionId, at: p.at, seq: p.seq, msg: p.msg })),
  };
  toSub(Buffer.from(`${JSON.stringify(hello)}\n`));
  let replayed = 0;
  const firstSeq = ringHead < ring.length ? ring[ringHead].seq : lastSeq + 1;
  if (since !== null) {
    if (since > lastSeq || since + 1 < firstSeq) toSub(eventLine("gap", { since, first: firstSeq, last: lastSeq }));
    for (let i = ringHead; i < ring.length; i++) {
      if (ring[i].seq <= since) continue;
      toSub(ring[i].buf);
      replayed++;
    }
  } else if (req.turns === true) {
    // The turns still running, as far as the ring holds them: each session's updates since its oldest running prompt.
    const starts = tracker.turnStarts();
    const oldest = Math.min(...[...starts.values()].filter((s) => Number.isInteger(s)));
    if (Number.isFinite(oldest) && oldest + 1 < firstSeq) toSub(eventLine("gap", { since: oldest, first: firstSeq, last: lastSeq }));
    for (let i = ringHead; i < ring.length; i++) {
      const r = ring[i];
      const start = r.turn === null ? undefined : r.turn === ANY_TURN ? oldest : starts.get(r.turn);
      if (!Number.isInteger(start) || r.seq <= start) continue;
      toSub(r.buf);
      replayed++;
    }
  }
  log(`stream ${id} (${client}) since ${since ?? (req.turns === true ? "turns" : "-")}: ${replayed} records replayed`);
}

function onSend(sock, id, msg) {
  if (stopping || !agentAlive) {
    refuse(sock, "agent-gone");
    return;
  }
  if (!isObj(msg) || (typeof msg.method !== "string" && msg.id === undefined)) {
    log(`conn ${id}: send refused (bad-request)`);
    refuse(sock, "bad-request");
    return;
  }
  const text = JSON.stringify(msg);
  const bytes = Buffer.byteLength(text);
  if (bytes > wire.MAX_LINE_BYTES) {
    log(`conn ${id}: send of ${bytes} bytes refused (too-large)`);
    refuse(sock, "too-large");
    return;
  }
  const c = tracker.fromClient(msg, Date.now(), lastSeq);
  if (c.kind === "request" && c.method === wire.METHOD.sessionPrompt && c.sessionId)
    promptLengths.set(c.sessionId, Array.from(wire.promptText(c.params?.prompt)).length);
  logMessage(`conn ${id}: client →`, c, bytes);
  agent.stdin.write(`${text}\n`, (err) => {
    if (err) {
      log(`conn ${id}: write to the agent failed: ${reason(err)}`);
      refuse(sock, "agent-gone");
    } else reply(sock, { ok: true });
  });
}

// Timers: ping, Herdr watch, idle.

setInterval(() => {
  if (stopping || !sub) return;
  if (Date.now() - subLastWrite >= wire.PING_MS) toSub(eventLine("ping"));
}, 1000);

setInterval(() => {
  if (stopping) return;
  try {
    process.kill(HERDR_PID, 0);
  } catch (e) {
    if (e.code !== "ESRCH") return;
    log(`herdr pid ${HERDR_PID} gone`);
    fastStop("herdr-gone");
  }
}, HERDR_POLL_MS);

setInterval(
  () => {
    if (stopping || !initDone) return;
    if (tracker.idleExpired(Date.now(), IDLE_MS)) {
      log(`idle for ${Date.now() - tracker.lastActivity()} ms`);
      gracefulStop("idle");
    }
  },
  Math.min(15000, Math.max(200, Math.floor(IDLE_MS / 4))),
);
