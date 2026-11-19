#!/usr/bin/env node
// lazuli's headless run wrapper (ARCHITECTURE §4.8, CONTRACTS "CLI: bin/run-agent.mjs"):
//   node run-agent.mjs <base>
// reads <base>.cmd, runs its argv in a process group of its own (stdin from /dev/null, stdout → <base>.out,
// stderr → <base>.err), writes <base>.pid after the start and <base>.exit once at the end.
//
// `sys/runner.js` starts it with `hc run --bg`; `hc kill` sends SIGHUP to this wrapper's group (spike S5),
// not to the command's. SIGHUP, SIGTERM or SIGINT here, or the timeout passing, send SIGTERM to the
// command's group, then SIGKILL to whatever of it still runs 10 s later.

import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute } from "node:path";

const KILL_AFTER_MS = 10000;
const MAX_TIMER_MS = 2147483647;
const EXTRA_PATH = (home) => [":/opt/homebrew/bin", "/usr/local/bin", `${home}/.local/bin`, `${home}/.claude/local`].join(":");

// The terminal may be gone (hc kill closes it): writing to it must never crash the wrapper.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const reason = (e) => e?.code || e?.message || String(e);

const base = process.argv[2];
if (typeof base !== "string" || !isAbsolute(base)) {
  process.stderr.write("usage: node run-agent.mjs <absolute base path without extension>\n");
  process.exit(2);
}

let exitWritten = false;

/** Writes <base>.exit once, through a temp file and a rename. */
function writeExit({ code = null, signal = null, timedOut = false, error = null }) {
  if (exitWritten) return true;
  const body = `${JSON.stringify({ code, signal, ended: Date.now(), timedOut, error })}\n`;
  const tmp = `${base}.exit.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, body);
    renameSync(tmp, `${base}.exit`);
    exitWritten = true;
  } catch (e) {
    process.stderr.write(`run-agent: cannot write ${base}.exit: ${reason(e)}\n`);
  }
  return exitWritten;
}

/** The validated <base>.cmd, or {error}. */
function readCmd() {
  let cmd;
  try {
    cmd = JSON.parse(readFileSync(`${base}.cmd`, "utf8"));
  } catch (e) {
    return { error: `cmd: ${reason(e)}` };
  }
  if (!isObj(cmd)) return { error: "cmd: not an object" };
  if (!Array.isArray(cmd.argv) || cmd.argv.length === 0 || !cmd.argv.every((a) => typeof a === "string") || cmd.argv[0] === "") {
    return { error: "cmd: argv" };
  }
  if (typeof cmd.cwd !== "string" || !isAbsolute(cmd.cwd)) return { error: "cmd: cwd" };
  const env = isObj(cmd.env) ? cmd.env : {};
  const set = isObj(env.set) ? env.set : {};
  const unset = Array.isArray(env.unset) ? env.unset : [];
  if (!Object.values(set).every((v) => typeof v === "string") || !unset.every((k) => typeof k === "string")) return { error: "cmd: env" };
  const timeoutMs = cmd.timeoutMs ?? null;
  if (timeoutMs !== null && !(typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0)) return { error: "cmd: timeoutMs" };
  return { argv: cmd.argv, cwd: cmd.cwd, set, unset, timeoutMs };
}

const cmd = readCmd();
if (cmd.error) {
  writeExit({ error: cmd.error });
  process.exit(2);
}

// Stopping. The handlers are set before the command starts: a SIGHUP from `hc kill` that lands while it
// starts must not take the default action (ending only this wrapper and orphaning the command). Its
// handler runs once this module has run, by when the command's group exists.
let pgid = 0;
let stopping = null; // {timedOut} once a stop was asked for
let killTimer = null;
let sentKill = false;

function signalGroup(sig) {
  if (!pgid) return false;
  try {
    process.kill(-pgid, sig);
    return true;
  } catch {
    return false;
  }
}

const groupAlive = () => signalGroup(0);

function beginStop() {
  if (killTimer || !pgid) return;
  signalGroup("SIGTERM");
  killTimer = setTimeout(() => {
    sentKill = true;
    signalGroup("SIGKILL");
  }, KILL_AFTER_MS);
}

function stop(timedOut) {
  if (stopping) return;
  stopping = { timedOut };
  beginStop();
}

for (const sig of ["SIGHUP", "SIGTERM", "SIGINT"]) process.on(sig, () => stop(false));

function childEnv() {
  const env = { ...process.env };
  for (const k of cmd.unset) delete env[k];
  Object.assign(env, cmd.set);
  const home = env.HOME || homedir();
  env.PATH = `${env.PATH ?? ""}${EXTRA_PATH(home)}`;
  return env;
}

function openOutputs() {
  try {
    return [openSync(`${base}.out`, "w"), openSync(`${base}.err`, "w")];
  } catch (e) {
    writeExit({ error: `spawn: ${reason(e)}` });
    process.exit(exitWritten ? 0 : 1);
  }
}

const [outFd, errFd] = openOutputs();

let child;
try {
  child = spawn(cmd.argv[0], cmd.argv.slice(1), {
    cwd: cmd.cwd,
    env: childEnv(),
    stdio: ["ignore", outFd, errFd],
    detached: true,
  });
} catch (e) {
  writeExit({ error: `spawn: ${reason(e)}` });
  process.exit(exitWritten ? 0 : 1);
}
closeSync(outFd);
closeSync(errFd);

pgid = child.pid ?? 0;

// setTimeout holds at most 2^31-1 ms (about 24.8 days): a longer timeout is waited out in steps against its
// real deadline.
let timeoutTimer = null;
if (cmd.timeoutMs !== null) {
  const deadline = Date.now() + cmd.timeoutMs;
  const arm = () => {
    const left = deadline - Date.now();
    if (left <= 0) stop(true);
    else timeoutTimer = setTimeout(arm, Math.min(left, MAX_TIMER_MS));
  };
  arm();
}

child.on("error", (e) => {
  // The command never started (no such program, no such folder).
  if (child.pid) return;
  clearTimeout(timeoutTimer);
  writeExit({ error: `spawn: ${reason(e)}` });
  process.exit(exitWritten ? 0 : 1);
});

if (pgid) {
  try {
    writeFileSync(`${base}.pid`, `${JSON.stringify({ pid: pgid, pgid, started: Date.now() })}\n`);
  } catch (e) {
    process.stderr.write(`run-agent: cannot write ${base}.pid: ${reason(e)}\n`);
  }
}

// After a stop, what is left of the group gets until the SIGKILL deadline, then the SIGKILL.
async function drainGroup() {
  while (groupAlive() && !sentKill) await new Promise((r) => setTimeout(r, 200));
  if (groupAlive()) signalGroup("SIGKILL");
}

child.on("exit", async (code, signal) => {
  clearTimeout(timeoutTimer);
  if (stopping) {
    await drainGroup();
    clearTimeout(killTimer);
    const sent = sentKill ? "SIGKILL" : "SIGTERM";
    writeExit({ code: null, signal: signal ?? sent, timedOut: stopping.timedOut });
  } else {
    writeExit({ code: typeof code === "number" ? code : null, signal: signal ?? null });
  }
  process.exit(exitWritten ? 0 : 1);
});
