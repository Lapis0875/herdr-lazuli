#!/usr/bin/env node
// S9 driver: talks ACP over stdio to a real `hermes -p <profile> acp` without
// ever sending a model prompt. Only slash commands that Hermes answers locally
// (acp_adapter/server.py:1356-1363 -> _handle_slash_command) are prompted.
//
//   node drive.mjs --hermes <abs> --cwd <abs> --out <dir> [--profile default]
//                  [--mode main|init] [--label <name>]
//
// main: initialize, session/new, session/list, session/set_model (current
//       model), /help, /version, /context, session/fork, session/load
//       (unknown id), then SIGTERM to the agent's process group.
// init: initialize only, then stdin EOF (cold-start sample).
//
// Every line is saved as {i, t, dir, msg[, redacted]} with t = ms since spawn.
// Message text (content.text of chunks) is replaced by "[redacted]" and its
// length and sha256 are kept in `redacted`. Slash-command prompts are kept.

import { spawn, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => {
    if (a.startsWith("--")) acc.push([a.slice(2), all[i + 1]]);
    return acc;
  }, []),
);
const HERMES = args.hermes;
const CWD = args.cwd;
const OUT = args.out;
const PROFILE = args.profile || "default";
const MODE = args.mode || "main";
const LABEL = args.label || MODE;
const LOCAL_COMMANDS = new Set(["/help", "/version", "/context"]);
if (!HERMES || !CWD || !OUT) {
  console.error("usage: drive.mjs --hermes <abs> --cwd <abs> --out <dir>");
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const t0 = performance.now();
const now = () => Math.round((performance.now() - t0) * 10) / 10;
const child = spawn(HERMES, ["-p", PROFILE, "acp"], {
  cwd: CWD,
  detached: true, // own process group, like the K3 bridge
  stdio: ["pipe", "pipe", "pipe"],
});
const pgid = child.pid;
const stderrPath = join("/tmp/lz-s9", `hermes-stderr-${LABEL}.log`);
writeFileSync(stderrPath, "");
child.stderr.on("data", (b) => appendFileSync(stderrPath, b));

let exitInfo = null;
const exited = new Promise((res) => {
  child.on("exit", (code, signal) => {
    exitInfo = { code, signal, t: now() };
    res(exitInfo);
  });
});

let seq = 0;
let file = null; // current step file
let lastRecv = 0;
let firstByteAt = null;
const pending = new Map();
const unexpected = [];
const nonJson = [];

function sha(s) {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function redact(msg) {
  const out = JSON.parse(JSON.stringify(msg));
  const notes = [];
  const u = out?.params?.update;
  if (u && u.content && typeof u.content.text === "string") {
    const text = u.content.text;
    notes.push({ path: "params.update.content.text", chars: text.length, lines: text.split("\n").length, sha256: sha(text) });
    u.content.text = "[redacted]";
  }
  if (Array.isArray(out?.params?.prompt)) {
    out.params.prompt.forEach((b, k) => {
      if (b.type === "text" && !LOCAL_COMMANDS.has(b.text)) {
        notes.push({ path: `params.prompt.${k}.text`, chars: b.text.length, sha256: sha(b.text) });
        b.text = "[redacted]";
      }
    });
  }
  return { msg: out, notes };
}

const answers = {}; // unredacted text per step, kept in /tmp only
function record(dir, msg) {
  const { msg: safe, notes } = redact(msg);
  const rec = { i: seq++, t: now(), dir, msg: safe };
  if (notes.length) rec.redacted = notes;
  if (file) appendFileSync(file, JSON.stringify(rec) + "\n");
  const text = msg?.params?.update?.content?.text;
  if (typeof text === "string" && currentStep) {
    answers[currentStep] = (answers[currentStep] || "") + text;
  }
}

let currentStep = null;
let buf = "";
child.stdout.on("data", (b) => {
  if (firstByteAt === null) firstByteAt = now();
  buf += b.toString("utf8");
  let nl;
  while ((nl = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    lastRecv = now();
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      nonJson.push(line.slice(0, 200));
      continue;
    }
    record("recv", msg);
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        p.resolve({ msg, t: now() });
      }
    } else if (msg.id !== undefined && msg.method) {
      // Agent -> client request (none expected: fs/terminal are off and no
      // model turn runs). Refuse it and remember it.
      unexpected.push({ step: currentStep, method: msg.method });
      const reply = { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "not supported by S9 driver" } };
      record("send", reply);
      child.stdin.write(JSON.stringify(reply) + "\n");
    }
  }
});

let nextId = 0;
function request(method, params, timeoutMs) {
  const id = nextId++;
  const msg = { jsonrpc: "2.0", id, method, params };
  const sentAt = now();
  record("send", msg);
  child.stdin.write(JSON.stringify(msg) + "\n");
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    pending.set(id, {
      resolve: (r) => {
        clearTimeout(timer);
        resolve({ ...r, sentAt, ms: Math.round((r.t - sentAt) * 10) / 10 });
      },
    });
  });
}

// Wait until no agent line arrived for `quietMs` (max `maxMs`), so notifications
// scheduled after a response (available_commands_update, usage_update) land in
// the same step file.
async function settle(quietMs = 1200, maxMs = 6000) {
  const start = now();
  while (now() - start < maxMs) {
    await new Promise((r) => setTimeout(r, 100));
    if (now() - lastRecv >= quietMs) return;
  }
}

function probe(step) {
  const line = { step, t: now() };
  try {
    line.net = execFileSync("/usr/sbin/lsof", ["-nP", "-a", "-i", "-p", String(child.pid)], { encoding: "utf8" }).trim();
  } catch (e) {
    line.net = e.status === 1 ? "" : `lsof failed: ${e.message}`;
  }
  try {
    const ps = execFileSync("/bin/ps", ["-axo", "pid=,ppid=,pgid=,comm="], { encoding: "utf8" });
    line.group = ps
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .filter((f) => f.length >= 4 && Number(f[2]) === pgid)
      .map((f) => ({ pid: Number(f[0]), ppid: Number(f[1]), comm: f.slice(3).join(" ") }));
  } catch (e) {
    line.group = `ps failed: ${e.message}`;
  }
  appendFileSync(join("/tmp/lz-s9", `probe-${LABEL}.jsonl`), JSON.stringify(line) + "\n");
  return line;
}

const steps = [];
async function step(name, fn) {
  currentStep = name;
  file = join(OUT, `${name}.jsonl`);
  writeFileSync(file, "");
  const r = await fn();
  await settle();
  const p = probe(name);
  steps.push({ step: name, ms: r?.ms, netLines: p.net ? p.net.split("\n").length - 1 : 0, groupSize: Array.isArray(p.group) ? p.group.length : null });
  return r;
}

async function stop(how) {
  const begin = now();
  if (how === "eof") child.stdin.end();
  else {
    try {
      process.kill(-pgid, "SIGTERM");
    } catch {}
  }
  const timer = new Promise((r) => setTimeout(() => r(null), 10000));
  let res = await Promise.race([exited, timer]);
  let forced = false;
  if (!res) {
    forced = true;
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {}
    res = await exited;
  }
  return { how, forced, exit: res, ms: Math.round((res.t - begin) * 10) / 10 };
}

const summary = { label: LABEL, mode: MODE, argv: [HERMES, "-p", PROFILE, "acp"], cwd: CWD, pid: child.pid };
try {
  const init = await step(MODE === "main" ? "01-initialize" : `cold-start-${LABEL}`, () =>
    request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: "lazuli", title: "lazuli", version: "0.0.0-s9" },
      },
      60000,
    ),
  );
  summary.coldStart = { firstStdoutByteMs: firstByteAt, initializeResponseMs: init.t };

  if (MODE === "main") {
    const created = await step("02-session-new", () => request("session/new", { cwd: CWD, mcpServers: [] }, 60000));
    const sid = created.msg.result.sessionId;
    const current = created.msg.result.models?.currentModelId;
    summary.sessionId = sid;
    summary.currentModelId = current;
    summary.sessionNewMs = created.ms;

    const list = await step("03-session-list", () => request("session/list", { cwd: CWD }, 15000));
    summary.listMs = list.ms;

    const setm = await step("04-session-set-model", () =>
      request("session/set_model", { sessionId: sid, modelId: current }, 30000),
    );
    summary.setModelMs = setm.ms;

    for (const [name, text] of [
      ["05-prompt-help", "/help"],
      ["06-prompt-version", "/version"],
      ["07-prompt-context", "/context"],
    ]) {
      if (!LOCAL_COMMANDS.has(text)) throw new Error(`refusing non-local prompt ${text}`);
      const r = await step(name, () =>
        request("session/prompt", { sessionId: sid, prompt: [{ type: "text", text }] }, 15000),
      );
      summary[name] = { ms: r.ms, stopReason: r.msg.result?.stopReason };
    }

    const fork = await step("08-session-fork", () =>
      request("session/fork", { sessionId: sid, cwd: CWD, mcpServers: [] }, 60000),
    );
    summary.forkSessionId = fork.msg.result?.sessionId;
    summary.forkMs = fork.ms;

    const unknown = randomUUID();
    summary.unknownSessionId = unknown;
    const load = await step("09-session-load-unknown", () =>
      request("session/load", { sessionId: unknown, cwd: CWD, mcpServers: [] }, 30000),
    );
    summary.loadUnknown = { ms: load.ms, result: load.msg.result, error: load.msg.error };

    currentStep = "10-shutdown";
    file = null;
    summary.shutdown = await stop("sigterm");
  } else {
    currentStep = "eof";
    file = null;
    summary.shutdown = await stop("eof");
  }
} catch (err) {
  summary.error = String(err?.message || err);
  if (!exitInfo) summary.shutdown = await stop("sigterm");
}
summary.steps = steps;
summary.unexpectedAgentRequests = unexpected;
summary.nonJsonStdoutLines = nonJson;
summary.answerFirstLines = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, v.split("\n")[0]]));
writeFileSync(join("/tmp/lz-s9", `answers-${LABEL}.json`), JSON.stringify(answers, null, 2));
console.log(JSON.stringify(summary, null, 2));
