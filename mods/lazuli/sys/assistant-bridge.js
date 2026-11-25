// The Assistant's bridges (CONTRACTS K3, K4; spikes S5, S8, S9): finding Hermes and Node, the once-per-start
// `acp --check`, the Herdr pid, launching a profile's bridge (bin/acp-bridge.mjs) with `hc run --bg`, reading its
// discovery file, the reuse rule, and removing finished bridge terminals.
//
// Runtime folder (K2): `~/.cache/lazuli/assistant/<home8>/`. The manager never writes discovery.
// Versioned discoveries and the associated stable lock in `v2/` are owned by the publishing bridge.
// The unversioned directory is read-only migration input.
// The Herdr process carries HC_TERMINAL_ID, so without --no-parent --no-notify the bridge's terminal would get a
// parent and hc would type notes into it (S8). A terminal that ended is kept by hc until `hc rm` (S5): the reaper
// reaps both generations of finished bridge terminals. `terminals()` lists live terminals only, and the
// JSON of `hc ls --all` has no labels or pids, so the reaper queries by label.
//
// Every function here runs host commands: callers check `checking()` first.

import { exec, hc, home, appHome, readTextFile, terminals } from "herdr";
import { createHash, randomBytes } from "crypto";
import * as wire from "../core/acp-wire.js";
import { checkArgv } from "../core/assistant-agents.js";

const LEGACY_LABEL = "lazuli.assistant";
const LABEL = "lazuli.assistant.v2";
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
  return { discovery: `${dir}/v2/${profile}.json`, legacy: `${dir}/${profile}.json`, log: `${dir}/v2/${profile}.log` };
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

/** Read-only liveness: an explicit no-match from ps establishes absence, a failed lookup does not. */
export async function pidState(pid, timeout = 5000) {
  if (!Number.isInteger(pid) || pid <= 0) return "unknown";
  try {
    const r = await exec("/bin/ps", ["-p", String(pid), "-o", "pid="], { timeout });
    if (r.code === 0 && r.stdout.trim() === String(pid)) return "present";
    if (r.code === 1 && r.stdout.trim() === "" && r.stderr.trim() === "") return "gone";
  } catch {}
  return "unknown";
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

const parse = (text) => text === null ? { state: "absent" } : wire.parseDiscovery(text);
const fingerprint = (text) => text === null ? "absent" : createHash("sha256").update(text).digest("hex");

/** Read both generations; absence means ENOENT, not an unreadable or malformed file. */
export async function readDiscovery(profile) {
  try {
    const node = await nodePath();
    if (node) {
      const { discovery, legacy } = bridgePaths(profile);
      const r = await exec(node, [bridgeScript(), "--inspect-discovery", discovery, legacy], { timeout: 5000 });
      if (r.code === 0) {
        const { current, legacy: old } = JSON.parse(r.stdout);
        if ([current, old].every((text) => text === null || typeof text === "string")) {
          const legacyRecord = parse(old);
          return { ...(current === null ? legacyRecord : parse(current)), previous: fingerprint(current),
            legacyPrevious: fingerprint(old), legacyRecord };
        }
      }
    }
  } catch {}
  return { state: "unreadable" };
}

/** The profiles that have a discovery file. */
export async function discoveredProfiles() {
  const profiles = new Set();
  for (const dir of [runtimeDir(), `${runtimeDir()}/v2`]) {
    try {
      const r = await exec("/bin/ls", [dir], { timeout: 5000 });
      if (r.code !== 0) continue;
      for (const n of r.stdout.split("\n")) if (n.endsWith(".json")) profiles.add(n.slice(0, -5));
    } catch {}
  }
  return [...profiles];
}

// ---- terminals ---------------------------------------------------------------------------------------------------

const labelled = (profile, label) => (t) => isObj(t?.labels) && t.labels[label] === profile;

/** A profile's bridge terminals, finished ones included: `hc ls --all --json --label <label>=<profile>` (that
 *  JSON has no labels or pids, so hc filters), each with the pid `terminals()` gives a live one (null for a finished
 *  one). The live ones `terminals()` lists when hc cannot be read. */
export async function bridgeTerminals(profile, label = LABEL) {
  const list = await listBridgeTerminals(profile, label);
  const live = terminals() ?? [];
  if (!list) return live.filter(labelled(profile, label));
  return list.map((t) => ({ ...t, pid: live.find((x) => x?.address === t.address)?.pid ?? null }));
}

async function listBridgeTerminals(profile, label = LABEL) {
  let list = null;
  try {
    const r = await hc(["ls", "--all", "--json", "--label", `${label}=${profile}`]);
    if (r.code === 0) {
      const v = JSON.parse(r.stdout);
      list = Array.isArray(v) ? v : Array.isArray(v?.terminals) ? v.terminals : null;
    } else log(`hc ls --all --label ${label}=${profile}: ${(r.stderr || r.stdout).trim()}`);
  } catch (e) {
    log(`hc ls --all --label ${label}=${profile} failed: ${errText(e)}`);
  }
  return list?.filter((t) => isObj(t) && typeof t.address === "string") ?? null;
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

/** Whether a listed terminal ended (its process gone). */
const ended = async (term) => term.state !== "live" && !(await pidAlive(term.pid));

/** Removes the finished bridge terminals of these profiles (K3: every 60 s). Resolves how many went. */
export async function reap(profiles) {
  let n = 0;
  for (const profile of new Set(profiles)) {
    if (typeof profile !== "string" || profile === "") continue;
    for (const term of [...await bridgeTerminals(profile), ...await bridgeTerminals(profile, LEGACY_LABEL)]) {
      if (!(await ended(term))) continue;
      if (await hcQuiet(["rm", term.address])) n++;
    }
  }
  if (n) log(`removed ${n} finished bridge terminal(s)`);
  return n;
}

/** Resolves true only when the old PID is confirmed gone. An ACK or a failed probe is not proof of exit. */
export async function awaitExit(cx, profile, pid) {
  for (let waited = 0; waited <= SHUTDOWN_WAIT_MS; waited += 200) {
    const state = await pidState(pid);
    if (state === "gone") {
      await reap([profile]);
      return true;
    }
    if (state === "unknown") return false;
    if (waited < SHUTDOWN_WAIT_MS) await cx.sleep(200);
  }
  return false;
}

// ---- launch -----------------------------------------------------------------------------------------------------

/** A failed start's code (discovery `error.code`) → the service's error (K4). */
const START_ERROR = Object.freeze({ "agent-exit": "agent-exit", "init-failed": "bridge-launch-failed", "init-timeout": "bridge-timeout" });
const LAUNCH_EXPIRED = Symbol("launch deadline");

function terminalAddress(stdout) {
  let address = null;
  for (const line of stdout.split("\n")) {
    try {
      const value = JSON.parse(line);
      if (isObj(value) && typeof value.address === "string") address = value.address;
    } catch {}
  }
  return address;
}

/** Stop only a terminal returned by this launch, never one found by profile or PID. */
export async function cancelLaunch(address) {
  if (!address) return;
  await hcQuiet(["kill", address]);
  await hcQuiet(["rm", address]);
}

/**
 * Launches a profile's bridge in `folder` and waits up to 45 s for its discovery file. Resolves `{discovery}` or
 * `{error, detail}` with `error` one of `bridge-launch-failed`, `bridge-timeout`, `agent-exit`. A terminal that ends
 * without a usable discovery file is removed; one that takes too long is killed and removed.
 */
export async function launch(cx, { profile, folder, herdrPid: pid, argv, snapshot, valid }) {
  if (!valid()) return { error: "disconnected" };
  const at = Date.now();
  const remaining = () => Math.max(0, at + LAUNCH_WAIT_MS - Date.now());
  let expired = false;
  let address = null;
  const deadline = cx.sleep(LAUNCH_WAIT_MS).then(() => LAUNCH_EXPIRED);
  const bounded = async (operation) => {
    const ms = remaining();
    if (expired || ms === 0) throw LAUNCH_EXPIRED;
    const result = await Promise.race([operation(ms), deadline]);
    if (result === LAUNCH_EXPIRED || remaining() === 0) throw LAUNCH_EXPIRED;
    return result;
  };
  let cleaning;
  const cleanup = () => {
    if (address && !cleaning) cleaning = cancelLaunch(address);
    return cleaning;
  };
  const cancelled = async () => {
    await bounded(cleanup);
    return { error: "disconnected" };
  };
  try {
    const node = await bounded(() => nodePath());
    if (!node) return { error: "bridge-launch-failed", detail: "node not found" };
    // A legacy writer cannot touch v2, but don't start another agent while it may still be running.
    const old = snapshot.legacyRecord;
    if (!old || old.state === "invalid"
        || (old.state !== "absent" && await bounded((ms) => pidState(old.pid, Math.min(ms, 5000))) !== "gone")) {
      return { error: "bridge-timeout", detail: "The legacy bridge could not be confirmed stopped" };
    }
    const live = terminals();
    if (!Array.isArray(live) || live.some(labelled(profile, LEGACY_LABEL))) {
      return { error: "bridge-timeout", detail: "A legacy bridge may still be running" };
    }
    const p = bridgePaths(profile);
    const launchId = randomBytes(16).toString("hex");
    if (!valid()) return { error: "disconnected" };
    const r = await bounded(() => hc([
      "run", "--bg", "--json", "--no-parent", "--no-notify", "--cwd", folder, "--label", `${LABEL}=${profile}`, "--",
      node, bridgeScript(), "--profile", profile, "--cwd", folder, "--discovery", p.discovery, "--log", p.log,
      "--herdr-pid", String(pid), "--idle-min", String(wire.IDLE_MIN), "--launch-id", launchId,
      "--previous", snapshot.previous, "--legacy", p.legacy, "--legacy-previous", snapshot.legacyPrevious, "--agent", "--", ...argv,
    ]).then((reply) => {
      address = terminalAddress(reply.stdout);
      if (expired) void cleanup();
      return reply;
    }));
    if (!valid()) return await cancelled();
    if (r.code !== 0) return { error: "bridge-launch-failed", detail: (r.stderr || r.stdout).trim() };
    log(`launched the ${profile} bridge as terminal ${address ?? "?"} in ${folder}`);
    // Lock losers may not appear in the live list. Only an exact finished row proves exit.
    let nextListing = 0;
    for (;;) {
      await bounded((ms) => cx.sleep(Math.min(POLL_MS, ms)));
      if (!valid()) return await cancelled();
      const text = await bounded(() => readTextFile(p.discovery).catch(() => null));
      if (!valid()) return await cancelled();
      const d = typeof text === "string" ? wire.parseDiscovery(text) : { state: "unreadable" };
      const mine = d.launchId === launchId;
      if (d.state === "ready" && mine && wire.discoveryMatches(d, { profile, cwd: folder, herdrPid: pid, argv })) {
        log(`${profile} bridge pid ${d.pid} ready on port ${d.port} after ${Date.now() - at} ms`);
        return { discovery: d, address };
      }
      const listed = address ? (terminals() ?? []).find((t) => t?.address === address) : null;
      let finished = listed?.state === "finished" ? listed : null;
      if (!listed && address && Date.now() >= nextListing) {
        const inventory = await bounded(() => listBridgeTerminals(profile));
        if (!valid()) return await cancelled();
        nextListing = Date.now() + 1000;
        finished = inventory?.find((t) => t.address === address && t.state === "finished") ?? null;
      }
      if (finished || (d.state === "failed" && mine && await bounded((ms) => pidState(d.pid, Math.min(ms, 5000))) === "gone")) {
        if (!valid()) return await cancelled();
        if (address) {
          const finishedAddress = address;
          address = null;
          await bounded(() => hcQuiet(["rm", finishedAddress]));
        }
        if (d.state === "failed" && mine) {
          log(`${profile} bridge failed to start: ${d.code} ${d.detail}`);
          return { error: START_ERROR[d.code] ?? "bridge-launch-failed", detail: d.detail };
        }
        return { error: "bridge-launch-failed", detail: `the bridge ended (${finished.reason ?? finished.state})` };
      }
    }
  } catch (e) {
    if (e !== LAUNCH_EXPIRED) return { error: "bridge-launch-failed", detail: errText(e) };
    expired = true;
    void cleanup();
    return valid() ? { error: "bridge-timeout", detail: `bridge did not start in ${LAUNCH_WAIT_MS / 1000} s` } : { error: "disconnected" };
  }
}
