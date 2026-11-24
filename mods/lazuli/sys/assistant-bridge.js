// The Assistant's bridges (CONTRACTS K3, K4; spikes S5, S8, S9): finding Hermes and Node, the once-per-start
// `acp --check`, the Herdr pid, launching a profile's bridge (bin/acp-bridge.mjs) with `hc run --bg`, reading its
// discovery file, the reuse rule, retiring stale bridges and removing finished bridge terminals.
//
// Runtime folder (K2): `~/.cache/lazuli/assistant/<home8>/`, `<home8>` the first 8 hex digits of sha256(app home), as
// for pdfd (ARCHITECTURE §5). The bridge makes it 0700 and writes `<profile>.json` (discovery) and `<profile>.log`
// there, both 0600; this module only reads them (and removes a stale discovery file with `rm`).
//
// Launch: `hc run --bg --json --no-parent --no-notify --cwd <folder> --label lazuli.assistant=<profile> -- <abs node>
// <bridge> --profile <p> --cwd <folder> --discovery … --log … --herdr-pid <pid> --idle-min 30 --agent -- <argv…>`.
// The Herdr process carries HC_TERMINAL_ID, so without --no-parent --no-notify the bridge's terminal would get a
// parent and hc would type notes into it (S8). A terminal that ended is kept by hc until `hc rm` (S5): the reaper
// removes finished `lazuli.assistant=<profile>` terminals every minute. `terminals()` lists live terminals only (as
// `hc ls` does: a finished one is counted in `hidden_finished`), and the JSON of `hc ls --all` carries no labels and no
// pids, so a profile's bridge terminals are listed by hc's own filter: `hc ls --all --json --label
// lazuli.assistant=<profile>` (one call per profile; `--label` takes K=V only).
//
// Every function here runs host commands: callers check `checking()` first.

import { exec, hc, home, appHome, readTextFile, terminals } from "herdr";
import { createHash } from "crypto";
import * as wire from "../core/acp-wire.js";
import { checkArgv } from "../core/assistant-agents.js";

export const LABEL = "lazuli.assistant";
/** The mod waits this long for a new bridge's discovery file (S9 cold start 0.6–1.6 s; K3). */
const LAUNCH_WAIT_MS = wire.DISCOVERY_WAIT_MS;
const POLL_MS = 100;
/** `acp --check` may take this long (S9: 0.46–0.68 s; a first run compiles Python). */
const CHECK_MS = 60000;
const LOOKUP_MS = 15000;
/** A bridge asked to shut down exits within 11 s with a running turn (K3). */
const SHUTDOWN_WAIT_MS = 12000;
const OUTPUT_MAX = 4000;

const log = (msg) => console.log(`[lazuli/assistant] ${msg}`);
const errText = (e) => e?.message ?? String(e);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** `~/.cache/lazuli/assistant/<home8>`. */
export function runtimeDir() {
  const tag = String(createHash("sha256").update(appHome()).digest("hex")).slice(0, 8);
  return `${home()}/.cache/lazuli/assistant/${tag}`;
}

/** A profile's discovery and log files. */
export function bridgePaths(profile) {
  const dir = runtimeDir();
  return { dir, discovery: `${dir}/${profile}.json`, log: `${dir}/${profile}.log` };
}

/** The bridge script of this app home. */
export const bridgeScript = () => `${appHome()}/mods/lazuli/bin/acp-bridge.mjs`;

// ---- host lookups -----------------------------------------------------------------------------------------------

// Herdr's own PATH may lack ~/.local/bin and Homebrew (S5): a program is looked up on PATH, then in the usual
// folders, then by the person's login shell, and used by its absolute path.
const LOOKUP = [
  'name="$1"; shift',
  'c=$(command -v "$name" 2>/dev/null)',
  'case "$c" in /*) [ -x "$c" ] && { echo "$c"; exit 0; };; esac',
  'for c in "$@"; do [ -x "$c" ] && { echo "$c"; exit 0; }; done',
  'c=$("${SHELL:-/bin/zsh}" -lic "command -v $name" </dev/null 2>/dev/null | tail -n 1)',
  'case "$c" in /*) [ -x "$c" ] && { echo "$c"; exit 0; };; esac',
  "exit 1",
].join("\n");

const candidates = (name) => [`${home()}/.local/bin/${name}`, `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`];

async function lookup(name) {
  try {
    const r = await exec("/bin/sh", ["-c", LOOKUP, "lazuli-lookup", name, ...candidates(name)], { timeout: LOOKUP_MS });
    const found = r.code === 0 ? r.stdout.trim().split("\n").pop() : "";
    return found.startsWith("/") ? found : null;
  } catch (e) {
    log(`looking for ${name} failed: ${errText(e)}`);
    return null;
  }
}

/** Where `hermes` was looked for, for the hermes-missing gate (gate.js shows the list). */
export const hermesLooked = () => ["PATH", ...candidates("hermes"), "login shell"];

let nodeBin = null;

/** The absolute path of `node` (hc starts programs with herdr-core's PATH). */
export async function nodePath() {
  if (!nodeBin) nodeBin = await lookup("node");
  return nodeBin;
}

/** The absolute path of `hermes`, or null. */
export const hermesPath = () => lookup("hermes");

/** Whether `path` is an executable file. */
async function executable(path) {
  try {
    return (await exec("/bin/test", ["-x", path], { timeout: 5000 })).code === 0;
  } catch {
    return false;
  }
}

/** Whether `path` is a folder. */
export async function folderExists(path) {
  try {
    return (await exec("/bin/test", ["-d", path], { timeout: 5000 })).code === 0;
  } catch {
    return false;
  }
}

let herdr = null;

/** Herdr's pid: the parent of a shell `exec` starts (K3). Null when it cannot be read. */
export async function herdrPid() {
  if (herdr) return herdr;
  try {
    const r = await exec("/bin/sh", ["-c", 'echo "$PPID"'], { timeout: 5000 });
    const pid = Number(r.stdout.trim());
    if (Number.isInteger(pid) && pid > 1) herdr = pid;
  } catch (e) {
    log(`Herdr's pid not read: ${errText(e)}`);
  }
  return herdr;
}

/** Whether a process runs. */
export async function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    return (await exec("/bin/kill", ["-0", String(pid)], { timeout: 5000 })).code === 0;
  } catch {
    return false;
  }
}

/**
 * The once-per-start check (K4): `hermes acp --check`, or `debugAgent ++ ["acp", "--check"]` (D30). Resolves
 * `{ok: true, bin}` (`bin` the agent program: the absolute hermes, or debugAgent[0]), or a gate:
 * `{gate: "hermes-missing", detail: {looked}}` (not found, or argv[0] not executable) or
 * `{gate: "hermes-check-failed", detail: {code, output}}` (`output`: its stdout and stderr).
 */
export async function checkAgent(debugAgent) {
  let bin;
  if (Array.isArray(debugAgent) && debugAgent.length) {
    bin = debugAgent[0].startsWith("/") ? debugAgent[0] : await lookup(debugAgent[0]);
    if (!bin || !(await executable(bin))) return { gate: "hermes-missing", detail: { looked: [debugAgent[0]] } };
  } else {
    bin = await hermesPath();
    if (!bin) return { gate: "hermes-missing", detail: { looked: hermesLooked() } };
  }
  const argv = checkArgv(Array.isArray(debugAgent) && debugAgent.length ? { debugAgent: [bin, ...debugAgent.slice(1)] } : { bin });
  let r;
  try {
    r = await exec(argv[0], argv.slice(1), { cwd: home(), timeout: CHECK_MS });
  } catch (e) {
    return { gate: "hermes-missing", detail: { looked: [bin], error: errText(e) } };
  }
  if (r.code === 0) return { ok: true, bin };
  const output = [r.stdout, r.stderr].map((s) => String(s ?? "").trim()).filter(Boolean).join("\n").slice(0, OUTPUT_MAX);
  log(`${argv.join(" ")} exited ${r.code}`);
  return { gate: "hermes-check-failed", detail: { code: r.code, output } };
}

// ---- discovery --------------------------------------------------------------------------------------------------

/** A profile's discovery file, checked (core/acp-wire.js parseDiscovery), or `{state: "absent"}`. */
export async function readDiscovery(profile) {
  let text = null;
  try {
    text = await readTextFile(bridgePaths(profile).discovery);
  } catch {
    text = null;
  }
  return typeof text === "string" ? wire.parseDiscovery(text) : { state: "absent" };
}

/** The profiles that have a discovery file. */
export async function discoveredProfiles() {
  try {
    const r = await exec("/bin/ls", [runtimeDir()], { timeout: 5000 });
    if (r.code !== 0) return [];
    return r.stdout
      .split("\n")
      .map((n) => n.trim())
      .filter((n) => n.endsWith(".json") && !n.includes(".tmp-"))
      .map((n) => n.slice(0, -5));
  } catch {
    return [];
  }
}

/** Removes a profile's discovery file when it still names `pid` (a newer bridge may have written its own). */
async function removeDiscovery(profile, pid) {
  const d = await readDiscovery(profile);
  if (d.state === "absent" || (Number.isInteger(pid) && d.pid !== pid)) return;
  try {
    await exec("/bin/rm", ["-f", bridgePaths(profile).discovery], { timeout: 5000 });
  } catch (e) {
    log(`stale discovery of ${profile} not removed: ${errText(e)}`);
  }
}

// ---- terminals ---------------------------------------------------------------------------------------------------

const labelled = (profile) => (t) => isObj(t?.labels) && t.labels[LABEL] === profile;

/** A profile's bridge terminals, finished ones included: `hc ls --all --json --label lazuli.assistant=<profile>` (that
 *  JSON has no labels or pids, so hc filters), each with the pid `terminals()` gives a live one (null for a finished
 *  one). The live ones `terminals()` lists when hc cannot be read. */
export async function bridgeTerminals(profile) {
  let list = null;
  try {
    const r = await hc(["ls", "--all", "--json", "--label", `${LABEL}=${profile}`]);
    if (r.code === 0) {
      const v = JSON.parse(r.stdout);
      list = Array.isArray(v) ? v : Array.isArray(v?.terminals) ? v.terminals : null;
    } else log(`hc ls --all --label ${LABEL}=${profile}: ${(r.stderr || r.stdout).trim()}`);
  } catch (e) {
    log(`hc ls --all --label ${LABEL}=${profile} failed: ${errText(e)}`);
  }
  const live = terminals() ?? [];
  if (!list) return live.filter(labelled(profile));
  return list
    .filter((t) => isObj(t) && typeof t.address === "string")
    .map((t) => ({ ...t, pid: live.find((x) => x?.address === t.address)?.pid ?? null }));
}

async function hcQuiet(args) {
  try {
    const r = await hc(args);
    if (r.code !== 0) log(`hc ${args.join(" ")}: ${(r.stderr || r.stdout).trim()}`);
    return r.code === 0;
  } catch (e) {
    log(`hc ${args.join(" ")} failed: ${errText(e)}`);
    return false;
  }
}

/** Ends a terminal's program (hc kill) when it still runs, then removes it (hc rm). */
async function killAndRemove(term) {
  if (term.state === "live") await hcQuiet(["kill", term.address]);
  await hcQuiet(["rm", term.address]);
}

/** Whether a listed terminal ended (its process gone). */
const ended = async (term) => term.state !== "live" && !(await pidAlive(term.pid));

/** Removes the finished bridge terminals of these profiles (K3: every 60 s). Resolves how many went. */
export async function reap(profiles) {
  let n = 0;
  for (const profile of new Set(profiles)) {
    if (typeof profile !== "string" || profile === "") continue;
    for (const term of await bridgeTerminals(profile)) {
      if (!(await ended(term))) continue;
      if (await hcQuiet(["rm", term.address])) n++;
    }
  }
  if (n) log(`removed ${n} finished bridge terminal(s)`);
  return n;
}

/** Kills an agent process group a dead bridge left (K3): only when its command line (`ps -o command=`, the argv joined
 *  with spaces) is that profile's agent: an `acp` word and `-p` followed by exactly the profile (`-p dev` is not
 *  `-p dev2`). */
async function killOrphanAgent(profile, agentPid) {
  if (!(await pidAlive(agentPid))) return;
  let command = "";
  try {
    command = (await exec("/bin/ps", ["-o", "command=", "-p", String(agentPid)], { timeout: 5000 })).stdout.trim();
  } catch {
    return;
  }
  const words = command.split(/\s+/);
  const ofProfile = words.some((w, i) => w === "-p" && words[i + 1] === profile);
  if (!words.includes("acp") || !ofProfile) {
    log(`not killing pid ${agentPid}: "${command.slice(0, 120)}" is not ${profile}'s agent`);
    return;
  }
  log(`killing the agent group ${agentPid} a dead ${profile} bridge left`);
  try {
    await exec("/bin/sh", ["-c", 'kill -s KILL -- "-$1"', "lazuli-kill", String(agentPid)], { timeout: 5000 });
  } catch (e) {
    log(`kill ${agentPid} failed: ${errText(e)}`);
  }
}

/**
 * A discovery that may not be reused (another folder, Herdr or agent argv, a dead bridge, no hello within 5 s, a failed
 * start): its labelled terminal gets `hc kill` and `hc rm` (K3), the profile's finished bridge terminals are removed,
 * an agent a dead bridge left is killed, the file removed.
 */
export async function retire(profile, d) {
  if (d.state === "ready" || d.state === "failed") {
    for (const term of await bridgeTerminals(profile)) if (term.pid === d.pid || (await ended(term))) await killAndRemove(term);
    if (d.state === "ready" && Number.isInteger(d.agentPid) && !(await pidAlive(d.pid))) await killOrphanAgent(profile, d.agentPid);
  }
  if (d.state !== "absent") await removeDiscovery(profile, d.pid ?? null);
}

/** Waits until a bridge's process is gone (after `shutdown`), then removes its terminal (finished, so found by the
 *  profile's finished terminals); a bridge still running after SHUTDOWN_WAIT_MS gets `hc kill`. */
export async function awaitExit(cx, profile, pid) {
  for (let waited = 0; waited < SHUTDOWN_WAIT_MS; waited += 200) {
    if (!(await pidAlive(pid))) break;
    await cx.sleep(200);
  }
  for (const term of await bridgeTerminals(profile)) if (term.pid === pid || (await ended(term))) await killAndRemove(term);
}

// ---- launch -----------------------------------------------------------------------------------------------------

/** A failed start's code (discovery `error.code`) → the service's error (K4). */
const START_ERROR = Object.freeze({ "agent-exit": "agent-exit", "init-failed": "bridge-launch-failed", "init-timeout": "bridge-timeout" });

/**
 * Launches a profile's bridge in `folder` and waits up to 45 s for its discovery file. Resolves `{discovery}` or
 * `{error, detail}` with `error` one of `bridge-launch-failed`, `bridge-timeout`, `agent-exit`. A terminal that ends
 * without a usable discovery file is removed; one that takes too long is killed and removed.
 */
export async function launch(cx, { profile, folder, herdrPid: pid, argv }) {
  const node = await nodePath();
  if (!node) return { error: "bridge-launch-failed", detail: "node not found" };
  const p = bridgePaths(profile);
  const at = Date.now();
  let address = null;
  try {
    const r = await hc([
      "run", "--bg", "--json", "--no-parent", "--no-notify", "--cwd", folder, "--label", `${LABEL}=${profile}`, "--",
      node, bridgeScript(), "--profile", profile, "--cwd", folder, "--discovery", p.discovery, "--log", p.log,
      "--herdr-pid", String(pid), "--idle-min", String(wire.IDLE_MIN), "--agent", "--", ...argv,
    ]);
    if (r.code !== 0) return { error: "bridge-launch-failed", detail: (r.stderr || r.stdout).trim() };
    for (const line of r.stdout.split("\n")) {
      try {
        const v = JSON.parse(line);
        if (isObj(v) && typeof v.address === "string") address = v.address;
      } catch {
        // Not the JSON line.
      }
    }
  } catch (e) {
    return { error: "bridge-launch-failed", detail: errText(e) };
  }
  log(`launched the ${profile} bridge as terminal ${address ?? "?"} in ${folder}`);
  // `terminals()` lists live terminals only: a launched terminal that is no longer listed (or listed as finished)
  // ended. A failed start is also read from its discovery file.
  const term = () => (address ? (terminals() ?? []).find((t) => t?.address === address) ?? null : null);
  let seen = null;
  for (let waited = 0; waited < LAUNCH_WAIT_MS; waited += POLL_MS) {
    await cx.sleep(POLL_MS);
    const d = await readDiscovery(profile);
    const t = term();
    if (t) seen = t;
    const mine = !seen?.pid || d.pid === seen.pid;
    if (d.state === "ready" && mine && d.startedAt >= at - 1000 && wire.discoveryMatches(d, { profile, cwd: folder, herdrPid: pid, argv })) {
      log(`${profile} bridge pid ${d.pid} ready on port ${d.port} after ${Date.now() - at} ms`);
      return { discovery: d, address };
    }
    const gone = (seen !== null && (!t || t.state !== "live")) || (d.state === "failed" && mine);
    if (gone && !(await pidAlive(seen?.pid ?? d.pid))) {
      const last = await readDiscovery(profile);
      if (address) await hcQuiet(["rm", address]);
      if (last.state === "failed" && (!seen?.pid || last.pid === seen.pid)) {
        log(`${profile} bridge failed to start: ${last.code} ${last.detail}`);
        return { error: START_ERROR[last.code] ?? "bridge-launch-failed", detail: last.detail };
      }
      return { error: "bridge-launch-failed", detail: `the bridge ended (${t?.reason ?? t?.state ?? "finished"})` };
    }
  }
  const t = term();
  if (t) await killAndRemove(t);
  else if (address) await hcQuiet(["rm", address]);
  return { error: "bridge-timeout", detail: `no discovery file in ${LAUNCH_WAIT_MS / 1000} s` };
}
