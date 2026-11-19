// The headless agent commands per tool and what their runs print (ARCHITECTURE §4.8, CONTRACTS C4).
// Argv forms follow cockpit 0.38.5 `core/src/agent.rs` and each CLI as checked on this Mac (omp 18.22.2,
// claude 2.1.311, codex 0.167.0). Pure.
//
// Checked by running each CLI once (2026-11-19):
// - `omp -p --session-dir <dir> -- <prompt>` writes `<dir>/<time>_<id>.jsonl` with the usual usage records
//   (CONTRACTS V3): the caller reads the cost from that file with `spend.ompUsage`, and the file path is the
//   session `omp --resume` / `--fork` take. stdout is the answer; stderr has progress only.
// - `codex exec` prints `session id: <uuid>` on stderr among its banner lines (V4); stdout is the answer.
//
// Read-only runs (`readOnly`, for AI helpers whose prompt holds text from PRs, reviews or CI logs): the
// tool itself refuses writes and commands, whatever the prompt says. Checked 2026-11-19:
// - omp 18.22.2: `--tools=read,grep,glob` alone still exposes MCP tools and xd:// devices (through `write`),
//   and one of them ran a command. `--approval-mode=always-ask` makes every write- and exec-tier call (MCP
//   tools are write tier, devices keep their tier) need a prompt, which print mode refuses: a live run
//   could not create a file. `find` is left out: it needs a judge model and fails the start otherwise.
// - claude 2.1.311 (`--help`): plan permission mode, only Read/Grep/Glob available and allowed, no MCP
//   servers but `--mcp-config` ones (none).
// - codex 0.167.0: `--sandbox read-only`; `-c mcp_servers={}` does not remove configured MCP servers (some
//   run shells), so the user config is not loaded (`--ignore-user-config`, auth still read) and neither are
//   execpolicy rules (`--ignore-rules`).
// The configured command's extra words are dropped for such a run: they could undo it (`--yolo`,
// `--dangerously-skip-permissions`, `--dangerously-bypass-approvals-and-sandbox`).

const ADAPTERS = ["omp", "claude", "codex"];

const READ_ONLY = Object.freeze({
  omp: Object.freeze(["--tools=read,grep,glob", "--approval-mode=always-ask"]),
  claude: Object.freeze(["--permission-mode", "plan", "--tools", "Read,Grep,Glob", "--allowedTools", "Read,Grep,Glob", "--strict-mcp-config"]),
  codex: Object.freeze(["--ignore-user-config", "--ignore-rules", "--sandbox", "read-only"]),
});

// Models that are a tool's own (upstream `models`): one another tool claims is never passed to it. OMP
// resolves any model name itself (fuzzy, any provider), so it takes every model.
const CLAIMS = {
  claude: ["haiku", "sonnet", "opus", "lightest", "light", "claude-"],
  codex: ["gpt-", "o1", "o3", "o4", "codex-"],
};

const str = (v) => (typeof v === "string" ? v : "");
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const words = (v) => (Array.isArray(v) ? v.map((w) => String(w)) : []);

const claims = (tool, model) => (CLAIMS[tool] ?? []).some((m) => model === m || ((m.endsWith("-") || m.endsWith("/")) && model.startsWith(m)));

function takesModel(tool, model) {
  if (tool === "omp") return model !== "lightest" && model !== "light";
  return claims(tool, model) || !Object.keys(CLAIMS).some((t) => claims(t, model));
}

/** The adapter for a command, by the base name of its executable; null for any other program. */
export function adapterOf(command) {
  const first = Array.isArray(command) ? command[0] : null;
  if (typeof first !== "string") return null;
  const base = first.split("/").pop();
  return ADAPTERS.includes(base) ? base : null;
}

/** Whether a read-only run of `command` can be enforced by the tool: one of the three adapters, not a
 *  `{prompt}` template. */
export function canReadOnly(command) {
  const base = words(command);
  return adapterOf(base) !== null && !base.some((w) => w.includes("{prompt}"));
}

/** The argv of an unattended run of `command` (the settings' agent command) on `prompt`. A word with
 *  `{prompt}` is filled and nothing else is added; otherwise the adapter's form applies, and an unknown
 *  program gets the prompt as its last word. `model` goes only to a tool that takes it; `edits` lets the
 *  run edit files without asking; `sessionDir` is where omp keeps the run's session. `readOnly` makes the
 *  tool itself refuse writes and commands (see the top of this file; `edits` is ignored, and only the
 *  command's executable is kept): null when the command cannot enforce it (`canReadOnly`). */
export function headlessArgv(command, prompt, o = {}) {
  const readOnly = o?.readOnly === true;
  if (readOnly && !canReadOnly(command)) return null;
  const base = readOnly ? words(command).slice(0, 1) : words(command);
  const p = str(prompt);
  if (base.some((w) => w.includes("{prompt}"))) return base.map((w) => w.split("{prompt}").join(p));
  const tool = adapterOf(base);
  const model = str(o?.model).trim();
  const edits = o?.edits === true && !readOnly;
  const useModel = model !== "" && tool !== null && takesModel(tool, model);
  const locked = readOnly ? READ_ONLY[tool] : [];
  switch (tool) {
    case "omp": {
      const out = [...base, "-p", ...locked];
      if (useModel) out.push("--model", model);
      if (str(o?.sessionDir)) out.push("--session-dir", o.sessionDir);
      return [...out, "--", p];
    }
    case "claude": {
      const out = [...base, "-p", p, "--output-format", "stream-json", "--verbose"];
      if (useModel) out.push(...(model === "lightest" || model === "light" ? ["--model", "haiku", "--effort", "low"] : ["--model", model]));
      if (edits) out.push("--permission-mode", "acceptEdits");
      return [...out, ...locked];
    }
    case "codex": {
      const out = [base[0], "exec", "--skip-git-repo-check", ...locked, ...base.slice(1)];
      if (useModel) out.push("--model", model);
      if (edits) out.push("--sandbox", "workspace-write");
      return [...out, p];
    }
    default:
      return [...base, p];
  }
}

/** The interactive argv that starts a new session branched from `session`, with the flags of `base`
 *  (`resume-tools.baseArgv`); null for a tool that cannot fork. */
export function forkArgv(tool, base, session) {
  const b = words(base);
  const s = str(session);
  if (!b.length || !s) return null;
  if (tool === "claude") return [...b, "--resume", s, "--fork-session"];
  if (tool === "codex") return [b[0], "fork", ...b.slice(1), s];
  if (tool === "omp") return [...b, "--fork", s];
  return null;
}

/** The session id on a `session id: <id>` line, as Codex prints on stderr (upstream `session_in`). */
function sessionLine(text) {
  for (const line of str(text).split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const id = line.slice(colon + 1).trim();
    if (line.slice(0, colon).trim().toLowerCase() === "session id" && /^[A-Za-z0-9_-]+$/.test(id)) return id;
  }
  return null;
}

function lastResult(out) {
  const lines = str(out).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith("{")) continue;
    try {
      const v = JSON.parse(line);
      if (isObj(v) && v.type === "result") return v;
    } catch {
      // Not a JSON line: Claude Code printed something else.
    }
  }
  return null;
}

/** What a finished run said: the text to show, its USD cost when the tool reports one, its session and
 *  whether it failed. Claude Code: its last `type:"result"` JSON line. Others: stdout, else stderr. */
export function parseOutput(tool, r) {
  const out = str(r?.out);
  const err = str(r?.err);
  const code = typeof r?.code === "number" ? r.code : null;
  if (tool === "claude") {
    const result = lastResult(out);
    if (result) {
      const text = str(result.result) || str(result.subtype);
      const usd = typeof result.total_cost_usd === "number" && Number.isFinite(result.total_cost_usd) ? result.total_cost_usd : null;
      return { text, usd, session: str(result.session_id) || null, isError: result.is_error === true || code !== 0 };
    }
    return { text: err.trim() || out.trim(), usd: null, session: null, isError: code !== 0 };
  }
  return {
    text: out.trim() || err.trim(),
    usd: null,
    session: tool === "codex" ? sessionLine(err) : null,
    isError: code !== 0,
  };
}

/** The first non-empty line, its leading `#` and spaces cut, at most `max` characters. */
export function summaryLine(text, max = 160) {
  const line = str(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "");
  return Array.from((line ?? "").replace(/^[# ]+/, "")).slice(0, max).join("");
}

/** A routine's prompt: its body, then who runs it, why and when, and that nobody answers questions. The
 *  caller appends `promptLanguageLine()`. */
export function routinePrompt(routine, o) {
  return (
    `${str(routine?.body).trim()}\n\n---\nlazuli runs this as the routine "${str(routine?.name)}" (${str(routine?.whenText)}): ` +
    `${str(o?.why)}, at ${str(o?.at)}. Nobody is watching: do what it asks without waiting for answers, then reply with ` +
    `what you did or found, its first line a one-line summary.`
  );
}
