// Session restore, the pure part: which AI tool a terminal runs, its argv without what picked or started a
// conversation, the command that resumes a session, the terminal label that records it and what a recorded
// terminal's restore looks like now. A port of lstack-herdr's lh-resume-tools.js (removed; git history ee5201a)
// (CONTRACTS resume-tools.js, C6);
// the watcher that acts on it is sys/resume.js.

/** The terminal label holding what to resume: JSON {tool, session, argv, cwd, pid, tried}. herdr-core keeps a
 *  terminal's labels when keep recovery gives a lost terminal a fresh shell (same address, new pid), so it outlives a
 *  reboot. */
export const LABEL = "lazuli.resume";

/** The label lstack-herdr wrote; only the migration (sys/migrate.js) reads it, to move it to LABEL. */
export const OLD_LABEL = "lstack-herdr.resume";

/** How long a sent resume line may take to start its tool before the restore counts as failed. */
export const SENT_WAIT_MS = 30000;

/** `bin`: the executable's name; `report`: the app the tool reports over OSC 7501. */
export const TOOLS = {
  claude: { name: "Claude Code", bin: "claude", report: "claude-code" },
  codex: { name: "Codex", bin: "codex", report: "codex" },
  omp: { name: "OMP", bin: "omp", report: "omp" },
};

// Flags as each CLI's --help lists them (claude 2.1.311, codex 0.167.0, omp 18.20.3). `value`: the next word is the
// flag's value; `optional`: the next word is, unless it is a flag; `variadic`: every word up to the next flag is.
// Unlisted flags take no value. `drop`: what picked a conversation, attached a first prompt's inputs or made a one-off
// checkout, with its arity. `once`: a run with no conversation to come back to.
const SPECS = {
  claude: {
    value: ["--agent", "--agents", "--append-system-prompt", "--autocompact", "--debug-file", "--effort", "--environment",
      "--fallback-model", "--input-format", "--json-schema", "--max-budget-usd", "--model", "-n", "--name", "--output-format",
      "--permission-mode", "--permission-prompts", "--plugin-dir", "--plugin-url", "--remote-control-session-name-prefix",
      "--setting-sources", "--settings", "--system-prompt", "--system-prompt-snapshot"],
    optional: ["-d", "--debug", "--prompt-suggestions", "--remote-control"],
    variadic: ["--add-dir", "--allowedTools", "--allowed-tools", "--betas", "--disallowedTools", "--disallowed-tools", "--file",
      "--mcp-config", "--tools"],
    drop: { "-r": "optional", "--resume": "optional", "--from-pr": "optional", "--teleport": "optional", "--cloud": "optional",
      "-w": "optional", "--worktree": "optional", "--session-id": "value", "-c": "bare", "--continue": "bare",
      "--fork-session": "bare", "--bg": "bare", "--background": "bare", "--tmux": "bare" },
    once: ["-p", "--print"],
  },
  codex: {
    value: ["-c", "--config", "--enable", "--disable", "--remote", "--remote-auth-token-env", "-m", "--model", "--local-provider",
      "-p", "--profile", "-s", "--sandbox", "-C", "--cd", "--add-dir", "-a", "--ask-for-approval"],
    optional: [],
    variadic: [],
    drop: { "-i": "variadic", "--image": "variadic", "--last": "bare", "--all": "bare", "--include-non-interactive": "bare" },
    once: [],
  },
  omp: {
    value: ["--model", "--smol", "--slow", "--plan", "--prewalk-into", "--plan-yolo-into", "--provider", "--api-key",
      "--system-prompt", "--system-prompt-template", "--append-system-prompt", "--profile", "--alias", "--cwd", "--mode",
      "--config", "--add-dir", "--session-dir", "--models", "--tools", "--thinking", "--service-tier", "--hook", "-e",
      "--extension", "--skills", "--spinner-interval", "--max-fps", "--motion", "--max-time", "--warn-cost", "--max-cost",
      "--approval-mode", "--plugin-dir"],
    optional: [],
    variadic: [],
    drop: { "-r": "optional", "--resume": "optional", "--restore": "optional", "--goal": "value", "-c": "bare",
      "--continue": "bare", "--from-claude": "bare", "--from-codex": "bare" },
    once: ["-p", "--print", "--no-session", "--export"],
  },
};
for (const s of Object.values(SPECS)) for (const k of ["value", "optional", "variadic", "once"]) s[k] = new Set(s[k]);

// Codex's subcommands that are not an interactive session; `resume` and `fork` are, and are rebuilt.
const CODEX_ONCE = new Set(["exec", "e", "review", "login", "logout", "mcp", "mcp-server", "plugin", "app-server", "app",
  "remote-control", "completion", "update", "doctor", "sandbox", "debug", "apply", "a", "archive", "delete", "unarchive",
  "migrate-rollouts", "migrate-nfs-db", "cloud", "exec-server", "features", "agents", "help"]);

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const basename = (p) => String(p ?? "").split("/").pop();

// Credentials never reach a record or a resume line: the label persists in herdr-core and the line lands in shell
// history. An option whose name looks like one (`--api-key`, `--remote-auth-token-env`, …) is dropped with its value,
// in both the `--flag value` and `--flag=value` forms; restore relies on the tool's usual credential source. None of
// the three CLIs has a short alias for such an option (their --help, 2026-11-19).
const SECRET = /api[-_]?key|token|secret|password|passwd|auth|bearer|credential/i;
// Options whose value is configuration that may embed a credential (codex `-c model_providers.x.api_key=…`, claude
// `--settings '{"apiKeyHelper": …}'`, an MCP config with an Authorization header): dropped when the value looks so.
const CONFIG = {
  claude: new Set(["--settings", "--mcp-config", "--agents"]),
  codex: new Set(["-c", "--config"]),
  omp: new Set(["--config"]),
};
const FLAG_LIKE = /^--?[A-Za-z]/;

/** The tool running in the terminal's foreground now, or null. A terminal at its own process (a shell prompt) only
 *  counts when that process is the tool itself (`hc run -- claude`). */
export function toolOf(t) {
  const fg = t?.foreground;
  if (!fg?.pid) return null;
  for (const [tool, d] of Object.entries(TOOLS)) if (fg.name === d.bin || basename(fg.argv?.[0]) === d.bin) return tool;
  // An interpreter running the tool (node .../cli.js): Herdr's program table and the tool's own report agree.
  const key = t.program?.agent ? t.program.key : null;
  return fg.pid !== t.pid && own(TOOLS, key) && t.report?.app === TOOLS[key].report ? key : null;
}

/** The tool's argv without what picked or started a conversation (resume and continue flags, a session id, a first
 *  prompt and its attachments), ready for resumeArgv; null for a run with nothing to resume (print mode, a codex
 *  subcommand). An interpreter-run tool comes back as its plain command. */
export function baseArgv(tool, argv) {
  if (!own(SPECS, tool)) return null;
  const spec = SPECS[tool];
  const args = Array.isArray(argv) ? argv.map(String) : [];
  const at = args.findIndex((a) => basename(a) === TOOLS[tool].bin);
  if (at < 0) return [TOOLS[tool].bin];
  const out = [args[at]];
  const rest = args.slice(at + 1);
  let i = 0;
  if (tool === "codex" && rest[0] && !rest[0].startsWith("-")) {
    if (rest[0] === "resume" || rest[0] === "fork") i = 1;
    else if (CODEX_ONCE.has(rest[0])) return null;
  }
  const nextIsWord = () => i + 1 < rest.length && !rest[i + 1].startsWith("-");
  for (; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("-") || a === "-") continue; // a first prompt or a session id
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq > 0 ? a.slice(0, eq) : a;
    if (spec.once.has(name)) return null;
    const drop = own(spec.drop, name) ? spec.drop[name] : undefined;
    const arity = drop ?? (spec.value.has(name) ? "value" : spec.optional.has(name) ? "optional" : spec.variadic.has(name) ? "variadic" : "bare");
    const secret = SECRET.test(name.replace(/^-+/, ""));
    const span = [a];
    if (eq < 0) {
      if (arity === "value") { if (i + 1 < rest.length) span.push(rest[++i]); }
      else if (arity === "optional") { if (nextIsWord()) span.push(rest[++i]); }
      else if (arity === "variadic") while (nextIsWord()) span.push(rest[++i]);
      // An unlisted credential option takes its value along unless the next word is itself an option.
      else if (secret && i + 1 < rest.length && !FLAG_LIKE.test(rest[i + 1])) span.push(rest[++i]);
    }
    const values = eq > 0 ? [a.slice(eq + 1)] : span.slice(1);
    const hidden = secret || (CONFIG[tool].has(name) && values.some((v) => SECRET.test(v)));
    if (!drop && !hidden) out.push(...span);
  }
  return out;
}

/** The argv that reopens `session` with the flags of `base` (from baseArgv). */
export function resumeArgv(tool, base, session) {
  return tool === "codex" ? [base[0], "resume", ...base.slice(1), session] : [...base, "--resume", session];
}

/** The session named by the discovery script's output (sys/resume.js FIND): Claude Code's session id, the id in a
 *  Codex rollout's file name, or OMP's absolute session file (its --resume takes a path). Null when it names none. */
export function sessionFrom(tool, stdout) {
  const line = String(stdout ?? "").trim().split("\n")[0]?.trim() ?? "";
  if (tool === "claude") return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(line) ? line : null;
  if (tool === "codex") return /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(line)?.[1] ?? null;
  return line.startsWith("/") && line.endsWith(".jsonl") ? line : null;
}

// Words a POSIX shell (sh, bash, zsh, fish) reads as themselves; zsh expands a leading `=`.
const PLAIN = /^[A-Za-z0-9_@%+:,./-][A-Za-z0-9_@%+=:,./-]*$/;
export const quote = (s) => (PLAIN.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

/** One shell line running argv, after `cd` into `cd` when given. */
export function shellLine(argv, cd = null) {
  const run = argv.map(quote).join(" ");
  return cd ? `cd ${quote(cd)} && ${run}` : run;
}

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

// A restore attempt: the shell it was typed into, when, and whether `hc send` failed.
function triedOf(v) {
  if (!isPlain(v) || !Number.isInteger(v.pid) || typeof v.at !== "number" || !Number.isFinite(v.at)) return null;
  return { pid: v.pid, at: v.at, failed: v.failed === true };
}

/** The label text for a record `{tool, session, argv, cwd, pid, tried}`. */
export function encodeRecord(r) {
  return JSON.stringify({ tool: r.tool, session: r.session, argv: r.argv, cwd: r.cwd ?? null, pid: r.pid, tried: triedOf(r.tried) });
}

/** The label's record, or null when absent or not one this version wrote: the tool must be known, the session and argv
 *  non-empty, every argv word a string and pid an integer. A malformed `tried` reads as null. The argv goes through
 *  baseArgv again, so a label written before credentials were stripped loses them here, before any use. */
export function decodeRecord(text) {
  if (typeof text !== "string" || !text) return null;
  let r;
  try {
    r = JSON.parse(text);
  } catch {
    return null;
  }
  const ok = isPlain(r) && own(TOOLS, r.tool) && typeof r.session === "string" && r.session && Array.isArray(r.argv)
    && r.argv.length && r.argv.every((a) => typeof a === "string") && Number.isInteger(r.pid);
  if (!ok) return null;
  const argv = baseArgv(r.tool, r.argv);
  if (!argv) return null;
  return { tool: r.tool, session: r.session, argv, cwd: typeof r.cwd === "string" ? r.cwd : null, pid: r.pid, tried: triedOf(r.tried) };
}

/** Where a recorded terminal's restore stands: null when there is nothing to restore (no record, its tool runs, or its
 *  shell is still the recorded one); "sent" while a resume line typed into this shell may still start its tool;
 *  "failed" when that send failed or the tool had not started SENT_WAIT_MS after it; "pending" when this shell has not
 *  been tried yet. */
export function restoreStatus(t, record, now) {
  if (!record || toolOf(t) || t?.pid === record.pid) return null;
  const tried = record.tried;
  if (tried && tried.pid === t?.pid) return tried.failed || now - tried.at >= SENT_WAIT_MS ? "failed" : "sent";
  return "pending";
}
