// Headless runs (ARCHITECTURE §4.8, §5; spike S5): a command started detached with `hc run --bg` under
// `bin/run-agent.mjs`, tracked by the terminal label `lazuli.run=<key>` and the run files beside `<base>`
// (`<base>.cmd/.pid/.out/.err/.exit/.txt`, CONTRACTS "CLI: bin/run-agent.mjs"). Such a terminal has no
// parent, shows nowhere and outlives exec's 600 s cap; `hc kill` sends SIGHUP to the wrapper, which stops the
// command's group. A finished terminal stays until `hc rm`, so every run's terminal is removed once read.
//
// Run files live under ~/.cache/lazuli, outside the app home where a mod may write: a text is written to a
// temp file under the app home with fs/promises, then moved into place with `mv` (its content never goes
// through argv, so no size limit applies); files are read with fs/promises (reads work anywhere in home).

import * as fs from "fs/promises";
import { appHome, exec, hc, home, machines, terminals } from "herdr";
import { adapterOf, parseOutput } from "../core/agent-cmd.js";

export const LABEL = "lazuli.run";
/** Poll interval while a view shows the run, and otherwise. */
export const WATCHED_MS = 2000;
export const UNWATCHED_MS = 15000;
/** A run this young may not be in terminals() yet. */
const START_GRACE_MS = 30000;
/** How far a group leader's start (ps etime, whole seconds) may be from `<base>.pid`'s `started`. */
const START_SLACK_MS = 3000;
const TAIL_BYTES = 65536;
const GIT_TIMEOUT_MS = 120000;
export const RUN_FILES = Object.freeze(["cmd", "pid", "out", "err", "exit", "txt"]);

const log = (msg) => console.log(`[lazuli/runner] ${msg}`);
const errText = (e) => e?.message ?? String(e);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** `~/.cache/lazuli`. */
export const cacheDir = () => `${home()}/.cache/lazuli`;
/** The base of a routine run: `~/.cache/lazuli/routines/<slug>/<id>`. */
export const routineBase = (slug, id) => `${cacheDir()}/routines/${slug}/${id}`;
/** The base of any other headless run: `~/.cache/lazuli/runs/<id>`. */
export const runBase = (id) => `${cacheDir()}/runs/${id}`;
/** The label value of a run: its base relative to `~/.cache/lazuli` (unique, unlike a routine run's id). */
export const keyOf = (base) => (base.startsWith(`${cacheDir()}/`) ? base.slice(cacheDir().length + 1) : base);
/** The wrapper script. */
export const runAgentPath = () => `${appHome()}/mods/lazuli/bin/run-agent.mjs`;

let nodeBin = null;

// hc run starts the program with herdr-core's environment, whose PATH may lack Homebrew: the absolute
// path `exec` (the user's real environment) finds.
async function nodePath() {
  if (nodeBin) return nodeBin;
  try {
    const r = await exec("/usr/bin/which", ["node"]);
    const found = r.code === 0 ? r.stdout.split("\n")[0].trim() : "";
    if (found) nodeBin = found;
  } catch (e) {
    log(`node not found: ${errText(e)}`);
  }
  return nodeBin ?? "node";
}

// Temp files of writeText: under the app home, where fs/promises may write.
const tmpDir = () => `${appHome()}/data/lazuli/tmp`;
let tmpSeq = 0;

/** Writes a text file anywhere in home, of any size: the text goes to a temp file under the app home, which
 *  `mv` then puts in place (a rename on the same volume, so readers see the old or the new file). */
export async function writeText(path, text) {
  const tmp = `${tmpDir()}/${Date.now().toString(36)}-${(tmpSeq++).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await fs.mkdir(tmpDir(), { recursive: true });
  await fs.writeFile(tmp, String(text));
  let r;
  try {
    r = await exec("/bin/sh", ["-c", 'mkdir -p "$(dirname "$2")" && mv -f "$1" "$2"', "lazuli-write", tmp, path]);
  } catch (e) {
    r = { code: -1, stderr: errText(e) };
  }
  if (r.code !== 0) {
    await fs.unlink(tmp).catch(() => {});
    throw new Error(r.stderr.trim() || `write ${path}: exit ${r.code}`);
  }
}

/** Creates a folder anywhere in home. */
export async function makeDir(path) {
  const r = await exec("mkdir", ["-p", path]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `mkdir ${path}: exit ${r.code}`);
}

/** Deletes a run's files (and its omp session folder `<base>.session`). */
export async function removeFiles(base) {
  const paths = [...RUN_FILES.map((ext) => `${base}.${ext}`), `${base}.session`];
  await exec("rm", ["-rf", ...paths]).catch((e) => log(`rm ${base}: ${errText(e)}`));
}

/** Removes a folder of runs only when it is empty (`rmdir`, never recursive): run files are deleted by
 *  their own ids (`removeFiles`), so a recreated routine's newer runs are never swept away with it. */
export async function removeDirIfEmpty(dir) {
  if (!dir.startsWith(`${cacheDir()}/`)) return;
  await exec("rmdir", [dir]).catch(() => {});
}

async function readJson(path) {
  try {
    const v = JSON.parse(await fs.readFile(path, "utf8"));
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** `<base>.exit` once the wrapper wrote it: `{code, signal, ended, timedOut, error}`. */
export const readExit = (base) => readJson(`${base}.exit`);
/** `<base>.pid`: `{pid, pgid, started}`. */
export const readPid = (base) => readJson(`${base}.pid`);

/** A whole text file, or "" when absent. */
export async function readText(path) {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return "";
  }
}

/** Output kept from a run for its text: whole up to 256 KiB, else its first 64 KiB, "…" and its last 192 KiB.
 *  The raw `.out`/`.err` stay on disk; the mod never reads them whole. */
const SHOWN_BYTES = 262144;
const HEAD_BYTES = 65536;

const BOUNDED = 'test -f "$1" || exit 0; s=$(wc -c < "$1") || exit 1; if [ "$s" -le "$2" ]; then cat "$1"; else head -c "$3" "$1"; printf "\\n…\\n"; tail -c "$4" "$1"; fi';

/** A bounded read of a file (see SHOWN_BYTES), "" when absent. */
export async function boundedText(path) {
  try {
    const r = await exec("/bin/sh", ["-c", BOUNDED, "lazuli-read", path, String(SHOWN_BYTES), String(HEAD_BYTES), String(SHOWN_BYTES - HEAD_BYTES)]);
    return r.code === 0 ? r.stdout : "";
  } catch {
    return "";
  }
}

// A text cut the same way, in characters.
const boundedString = (s) => (s.length <= SHOWN_BYTES ? s : `${s.slice(0, HEAD_BYTES)}\n…\n${s.slice(s.length - (SHOWN_BYTES - HEAD_BYTES))}`);

// Runs a Node ESM script in a child (`node --input-type=module -e`), which streams large files the mod
// must not hold: its stdout parsed as JSON, or null.
async function nodeJson(script, args, label) {
  try {
    const r = await exec(await nodePath(), ["--input-type=module", "-e", script, "--", ...args], { timeout: 120000 });
    return r.code === 0 ? JSON.parse(r.stdout) : null;
  } catch (e) {
    log(`${label}: ${errText(e)}`);
    return null;
  }
}

// The last `"type":"result"` record of a Claude Code stream, however long the stream or the line: read in a
// Node child line by line, its text cut as `boundedString`, its cost, session and error flag whole.
const CLAUDE_RESULT = [
  'import { createReadStream } from "node:fs";',
  'import { createInterface } from "node:readline";',
  "const [file, shown, head] = [process.argv[1], Number(process.argv[2]), Number(process.argv[3])];",
  "let last = null;",
  "for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {",
  "  if (!line.includes('\"result\"')) continue;",
  "  try { const v = JSON.parse(line); if (v && v.type === 'result') last = v; } catch {}",
  "}",
  "if (!last) { process.stdout.write('null'); } else {",
  "  let text = typeof last.result === 'string' ? last.result : '';",
  "  if (text.length > shown) text = text.slice(0, head) + '\\n…\\n' + text.slice(text.length - (shown - head));",
  "  process.stdout.write(JSON.stringify({ type: 'result', result: text, subtype: typeof last.subtype === 'string' ? last.subtype : '',",
  "    is_error: last.is_error === true, total_cost_usd: typeof last.total_cost_usd === 'number' ? last.total_cost_usd : null,",
  "    session_id: typeof last.session_id === 'string' ? last.session_id : null }));",
  "}",
].join("\n");

/** A Claude Code run's result record as one JSON line (`parseOutput` reads it), or null when it has none. */
async function claudeResult(path) {
  const v = await nodeJson(CLAUDE_RESULT, [path, String(SHOWN_BYTES), String(HEAD_BYTES)], `claude result of ${path}`);
  return isObj(v) && v.type === "result" ? JSON.stringify(v) : null;
}

/** The last 64 KiB of `<base>.out` (or `.err`), for a view following a run. */
export async function tail(base, which = "out", bytes = TAIL_BYTES) {
  try {
    const r = await exec("tail", ["-c", String(bytes), `${base}.${which}`]);
    return r.code === 0 ? r.stdout : "";
  } catch {
    return "";
  }
}

/**
 * Starts a run: writes `<base>.cmd`, then `hc run --bg --json --cwd <cwd> --label lazuli.run=<key> --
 * node run-agent.mjs <base>`. `env` = `{set, unset}`. Resolves `{address}`, or `{error}` with a code:
 * `write` (the .cmd file), `hc-run` (hc refused it; `detail` holds its stderr).
 */
export async function start({ base, argv, cwd, env, timeoutMs }) {
  const cmd = {
    version: 1,
    argv,
    cwd,
    env: { set: isObj(env?.set) ? env.set : {}, unset: Array.isArray(env?.unset) ? env.unset : [] },
    timeoutMs: typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : null,
  };
  try {
    await writeText(`${base}.cmd`, JSON.stringify(cmd));
  } catch (e) {
    return { error: "write", detail: errText(e) };
  }
  const node = await nodePath();
  let r;
  try {
    r = await hc(["run", "--bg", "--json", "--cwd", cwd, "--label", `${LABEL}=${keyOf(base)}`, "--", node, runAgentPath(), base]);
  } catch (e) {
    return { error: "hc-run", detail: errText(e) };
  }
  if (r.code !== 0) return { error: "hc-run", detail: (r.stderr || r.stdout).trim() };
  for (const line of r.stdout.split("\n")) {
    try {
      const v = JSON.parse(line);
      if (isObj(v) && typeof v.address === "string") return { address: v.address };
    } catch {
      // Not the JSON line.
    }
  }
  return { error: "hc-run", detail: r.stdout.trim() };
}

/** The terminal labelled for this run (a live one first), or null. */
export function terminalOf(base) {
  const key = keyOf(base);
  let found = null;
  for (const t of terminals()) {
    if (t?.labels?.[LABEL] !== key) continue;
    if (t.state === "live") return t;
    found = found ?? t;
  }
  return found;
}

/** Every terminal a lazuli run left, as `{address, key, live}`. */
export function runTerminals() {
  return terminals()
    .filter((t) => typeof t?.labels?.[LABEL] === "string")
    .map((t) => ({ address: t.address, key: t.labels[LABEL], live: t.state === "live" }));
}

// Until this machine's layout is ready, terminals() may not list runs that still go on.
const localReady = () => (machines().find((m) => m.name === null)?.layout ?? "ready") === "ready";

// "[[dd-]hh:]mm:ss" (ps etime) → ms.
function elapsedMs(text) {
  const m = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!m) return null;
  const [d, h, mi, s] = m.slice(1).map((v) => Number(v ?? 0));
  return (((d * 24 + h) * 60 + mi) * 60 + s) * 1000;
}

/** The run's process group, but only when its leader (pid = pgid) is still the command the wrapper started:
 *  it leads that group, and either its parent is the live terminal labelled for this run (the wrapper) or
 *  it started when `<base>.pid` says (within 3 s). After a restart a stale `.pid` may name a pgid that is
 *  now someone else's: then this is null and nothing may be signalled. */
export async function ownGroup(base) {
  const pid = await readPid(base);
  const pgid = pid?.pgid;
  if (!Number.isInteger(pgid) || pgid <= 1 || typeof pid.started !== "number") return null;
  const asked = Date.now();
  let r;
  try {
    r = await exec("/bin/ps", ["-o", "pid=,ppid=,pgid=,etime=", "-p", String(pgid)]);
  } catch {
    return null;
  }
  if (r.code !== 0) return null;
  const f = r.stdout.trim().split(/\s+/);
  if (f.length !== 4 || Number(f[0]) !== pgid || Number(f[2]) !== pgid) return null;
  const t = terminalOf(base);
  if (t?.state === "live" && Number.isInteger(t.pid) && t.pid === Number(f[1])) return pgid;
  const elapsed = elapsedMs(f[3]);
  return elapsed !== null && Math.abs(asked - elapsed - pid.started) <= START_SLACK_MS ? pgid : null;
}

async function signalGroup(pgid, sig) {
  try {
    return (await exec("/bin/kill", [`-${sig}`, "--", `-${pgid}`])).code === 0;
  } catch {
    return false;
  }
}

/**
 * Where a run is: `{state: "running", address}`, `{state: "done", exit, address}`, or `{state: "lost",
 * address}` when no exit file came and nothing of it is known to run: no live terminal, and no process
 * group `ownGroup` can tell is this run's. `started` (ms) gives a just-started run whose terminal is not
 * listed yet time to appear in terminals(); a listed terminal that finished needs no such wait.
 */
export async function status({ base, started = 0, now = Date.now() }) {
  const exit = await readExit(base);
  const t = terminalOf(base);
  const address = t?.address ?? null;
  if (exit) return { state: "done", exit, address };
  if (t?.state === "live" || !localReady() || (!t && now - started < START_GRACE_MS)) return { state: "running", address };
  if ((await ownGroup(base)) !== null) return { state: "running", address };
  const late = await readExit(base);
  return late ? { state: "done", exit: late, address } : { state: "lost", address };
}

/** Removes a finished run's terminal. */
export async function release(address) {
  if (!address) return;
  try {
    await hc(["rm", address]);
  } catch (e) {
    log(`hc rm ${address}: ${errText(e)}`);
  }
}

/** `hc kill` on an address. Callers pass only an address that is this run's: one `terminalOf` just found by
 *  the run's label, or the one `hc run` just returned for it. The wrapper then writes the exit file;
 *  `release` removes the terminal once that is read. */
export async function cancel(address) {
  if (!address) return;
  try {
    await hc(["kill", address]);
  } catch (e) {
    log(`hc kill ${address}: ${errText(e)}`);
  }
}

/** Stops a run by what proves it is this run's, looked up right now: the live terminal labelled
 *  `lazuli.run=<key>` (`hc kill`, SIGHUP to the wrapper), else, when the wrapper is gone (a restart), its
 *  process group once `ownGroup` vouches for it (SIGTERM). A saved address is never used: after a restart
 *  it may be someone else's terminal. `fresh` may be the address `hc run` returned for this run in this same
 *  session, for the moment before terminals() lists it: it is used only while no terminal with another
 *  label holds it. Resolves how: "terminal", "group", or "lost" when nothing of the run could be verified,
 *  and nothing was signalled. */
export async function terminate(base, fresh = null) {
  const t = terminalOf(base);
  if (t?.state === "live") {
    await cancel(t.address);
    return "terminal";
  }
  const pgid = await ownGroup(base);
  if (pgid !== null) {
    await signalGroup(pgid, "TERM");
    return "group";
  }
  if (fresh && !t && !terminals().some((x) => x?.address === fresh)) {
    await cancel(fresh);
    return "terminal";
  }
  return "lost";
}

/** A stop that did not end the run: SIGKILL to the command's group once `ownGroup` vouches for it, then
 *  the terminal labelled for this run (looked up now) killed and removed. Resolves "killed", or "lost" when
 *  neither could be verified, and nothing was signalled. */
export async function kill(base) {
  const pgid = await ownGroup(base);
  if (pgid !== null) await signalGroup(pgid, "KILL");
  const t = terminalOf(base);
  if (t) {
    if (t.state === "live") await cancel(t.address);
    await release(t.address);
  }
  return pgid !== null || t ? "killed" : "lost";
}

/** Waits inside a task for a run to end, reading it every 2 s while `watched()` and every 15 s otherwise.
 *  Resolves the final status ("done" or "lost"); the terminal is removed. */
export async function waitFor(cx, { base, started, watched = () => false }) {
  for (;;) {
    const s = await status({ base, started });
    if (s.state !== "running") {
      await release(s.address);
      return s;
    }
    const ms = watched() ? WATCHED_MS : UNWATCHED_MS;
    await new Promise((resolve) => cx.timer.after(ms, () => resolve()));
  }
}

// What a run said.

// Sums an omp session's USD in a Node child, streaming its files line by line with `spend.ompUsage`: a
// long session is never held in the mod's runtime.
const OMP_COST = [
  'import { createReadStream } from "node:fs";',
  'import { createInterface } from "node:readline";',
  "const { ompUsage } = await import(process.argv[1]);",
  "let usd = null;",
  "for (const file of process.argv.slice(2)) {",
  "  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {",
  "    if (!line.includes('\"cost\"')) continue;",
  "    try { const e = ompUsage(JSON.parse(line)); if (e && typeof e.usd === 'number') usd = (usd ?? 0) + e.usd; } catch {}",
  "  }",
  "}",
  "process.stdout.write(JSON.stringify({ usd }));",
].join("\n");

/** The cost and session file of an omp run from its `--session-dir` (CONTRACTS C4, V3), subagents included. */
async function ompSession(dir) {
  let names;
  try {
    names = await fs.readdir(dir);
  } catch {
    return { usd: null, session: null };
  }
  const main = names.filter((n) => n.endsWith(".jsonl") && !n.startsWith(".")).sort().pop();
  if (!main) return { usd: null, session: null };
  const files = [`${dir}/${main}`];
  const sub = `${dir}/${main.slice(0, -6)}`;
  try {
    for (const n of await fs.readdir(sub)) if (n.endsWith(".jsonl")) files.push(`${sub}/${n}`);
  } catch {
    // No subagents.
  }
  const v = await nodeJson(OMP_COST, [`${appHome()}/mods/lazuli/core/spend.js`, ...files], `omp cost of ${dir}`);
  const usd = typeof v?.usd === "number" && Number.isFinite(v.usd) ? v.usd : null;
  return { usd, session: `${dir}/${main}` };
}

/** What an ended run said (`s` from `status`), from bounded reads of its files with `agent-cmd.parseOutput`
 *  (the tool from `<base>.cmd`): a Claude Code result record streamed from `.out` in a child, else the bounded
 *  text of `.out`/`.err`. The text, bounded the same way, also goes to `<base>.txt`. Resolves `{code, text,
 *  usd, session, isError, error, tool}`; `error`: null, `lost`, `timed-out` (the wrapper's own timeout) or
 *  the wrapper's `spawn: …`. */
export async function outcome(base, s) {
  const exit = s.state === "done" ? s.exit : null;
  const code = typeof exit?.code === "number" ? exit.code : null;
  let argv = [];
  try {
    argv = JSON.parse(await readText(`${base}.cmd`)).argv ?? [];
  } catch {
    // No command file: read as plain output.
  }
  const tool = adapterOf(argv);
  const err = await boundedText(`${base}.err`);
  const out = (tool === "claude" ? await claudeResult(`${base}.out`) : null) ?? (await boundedText(`${base}.out`));
  const parsed = parseOutput(tool, { out, err, code });
  let { usd, session } = parsed;
  if (tool === "omp") ({ usd, session } = await ompSession(`${base}.session`));
  const text = boundedString(parsed.text || err.trim());
  await writeText(`${base}.txt`, text).catch((e) => log(`txt: ${errText(e)}`));
  const error = s.state === "lost" ? "lost" : exit?.error ? exit.error : exit?.timedOut ? "timed-out" : null;
  return { code, text, usd, session, isError: parsed.isError, error, tool };
}

// Worktrees for routine runs (upstream `worktree`, `settle`, `remove_worktree`): never forced.

async function git(dir, args) {
  try {
    const r = await exec("git", ["-C", dir, "--no-optional-locks", "-c", "core.fsmonitor=false", ...args], { timeout: GIT_TIMEOUT_MS });
    return r.code === 0 ? { ok: true, out: r.stdout.trim() } : { ok: false, out: r.stderr.trim() };
  } catch (e) {
    return { ok: false, out: errText(e) };
  }
}

/** Whether a folder exists (anywhere). */
export async function isDir(path) {
  try {
    return (await exec("test", ["-d", path])).code === 0;
  } catch {
    return false;
  }
}

/** A git worktree of `cwd`'s repository for one run, on a new branch `auto/<slug>-<id>` at
 *  `~/.herdr/worktrees/<repo>/<branch>`: `{worktree: {path, cwd, branch, repo, base}}` or `{error, detail?}`. */
export async function makeWorktree(cwd, slug, id) {
  const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return { error: "worktree-no-repo" };
  const prefix = (await git(cwd, ["rev-parse", "--show-prefix"])).out.replace(/\/+$/, "");
  const name = top.out.split("/").pop();
  const branch = `auto/${slug}-${id}`;
  const path = `${home()}/.herdr/worktrees/${name}/${branch}`;
  const head = await git(top.out, ["rev-parse", "HEAD"]);
  if (!head.ok) return { error: "worktree", detail: head.out };
  const add = await git(top.out, ["worktree", "add", "-q", "-b", branch, path, "HEAD"]);
  if (!add.ok) return { error: "worktree", detail: add.out };
  return { worktree: { path, cwd: prefix ? `${path}/${prefix}` : path, branch, repo: top.out, base: head.out } };
}

/** The worktree and its branch removed as git allows (a branch with commits only once merged). */
export async function removeWorktree(wt) {
  if (await isDir(wt.path)) {
    const r = await git(wt.repo, ["worktree", "remove", wt.path]);
    if (!r.ok) return false;
  }
  const own = await git(wt.repo, ["rev-list", "--count", `${wt.base}..${wt.branch}`]);
  const empty = own.ok && Number(own.out) === 0;
  return (await git(wt.repo, ["branch", empty ? "-D" : "-d", wt.branch])).ok;
}

/** What a run left in its worktree, `{...wt, dirty, commits}`; one that left nothing is removed (`removed`). */
export async function settleWorktree(wt) {
  const out = { ...wt };
  if (!(await isDir(wt.path))) return { ...out, removed: true };
  const status = await git(wt.path, ["status", "--porcelain"]);
  const count = await git(wt.path, ["rev-list", "--count", `${wt.base || "HEAD"}..HEAD`]);
  out.dirty = !status.ok || status.out !== "";
  out.commits = count.ok ? Number(count.out) || 0 : 0;
  if (!out.dirty && out.commits === 0 && (await removeWorktree(wt))) out.removed = true;
  return out;
}
