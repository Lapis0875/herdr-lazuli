// lstack-herdr call tree: omp's task subagents as OSC 7501 child records on the terminal omp runs in, so the Herdr
// app (`terminals()[].records`) draws who started whom, live.
//
// Records (one per subagent, replaced whole by each report):
//   id    = the subagent's transcript path under the root session, without `.jsonl`: `AgentTreeData`,
//           `Beta/Beta.Gamma` (nested subagents live in their parent's artifacts directory, named `<parent>.<name>`)
//   state = started → working, completed → done, failed → error, aborted → error
//   title = "<agent type> · <name>", and for error "<agent type> · <name> · failed|aborted": herdr-core keeps `kind`
//           only on blocked records (OSC 7501 says so), so the failure's kind rides in the title
//   msg   = the task's first meaningful line (≤ 2048 bytes)
// plus the reserved `_session` record (state idle) whose msg is the root session's absolute .jsonl path, sent at start
// and on every session switch (the old session's subagent records are cleared first), and again every 64 subagent
// reports: herdr-core keeps 255 records a terminal and drops the least recently updated one past that.
//
// Writes go through omp's own terminal output path (pi-tui's writeTerminalSequence, the one run-status.ts uses): a
// TUI frame is pumped to stdout in chunks that ignore escape boundaries, so a direct stdout write could split it.
//
// Symlinked from ~/.omp/agent/extensions/lstack-herdr-tree.ts; source: ~/.config/herdr-app/mods/lstack-herdr/omp/.

import { writeTerminalSequence } from "@oh-my-pi/pi-tui";
import * as path from "node:path";

const OSC = "\x1b]7501;";
const ST = "\x1b\\";
const MSG_MAX_BYTES = 2048;
const TITLE_MAX_BYTES = 192;
const SEGMENT = /^[A-Za-z0-9_.+-]{1,32}$/;
const MAX_DEPTH = 8;
const SESSION_REFRESH = 64;
// Only an omp drawing to a herdr-core terminal reports. Headless runs (`omp -p`, RPC, a hub's recap) have a piped
// stdout: an OSC there lands in the program's captured output instead of reaching herdr-core.
const ENABLED = Boolean(process.env.HC_TERMINAL_ID) && process.stdout.isTTY === true;

type Lifecycle = {
  id?: string;
  agent?: string;
  status?: "started" | "completed" | "failed" | "aborted";
  description?: string;
  sessionFile?: string;
};

type State = {
  /** The root session's .jsonl (the interactive session this terminal shows). */
  root: string | null;
  /** Last report written per record id, so a repeated status writes nothing. */
  reported: Map<string, string>;
  /** Task text by "<parent session file>\0<task name>", from the parent's task tool call. */
  tasks: Map<string, string>;
  /** Subagent reports since `_session` was last written. */
  sinceSession: number;
};

// Module state survives the per-session factory rebinding (subagents reuse the imported module) and `/reload`
// (a re-import with a cache-buster), so it lives on globalThis.
const KEY = Symbol.for("lstack-herdr.tree");
const G: State = ((globalThis as Record<symbol, unknown>)[KEY] as State) ?? { root: null, reported: new Map(), tasks: new Map(), sinceSession: 0 };
(globalThis as Record<symbol, unknown>)[KEY] = G;
G.sinceSession ??= 0;

function b64(text: string, maxBytes: number): string | undefined {
  // eslint-disable-next-line no-control-regex
  let line = text.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  let buf = Buffer.from(line);
  if (buf.length > maxBytes) {
    while (Buffer.byteLength(`${line}…`) > maxBytes) line = line.slice(0, -1);
    line = `${line.trimEnd()}…`;
    buf = Buffer.from(line);
  }
  return buf.toString("base64");
}

function write(id: string, body: string): void {
  if (!ENABLED) return;
  const report = `${OSC}${body}${ST}`;
  if (G.reported.get(id) === report) return;
  G.reported.set(id, report);
  try {
    writeTerminalSequence(report);
  } catch {
    // Best-effort: a closed terminal must not fail the agent.
  }
  if (id === "_session") G.sinceSession = 0;
  else if (++G.sinceSession >= SESSION_REFRESH) {
    G.reported.delete("_session");
    sendSession();
  }
}

function clear(id: string): void {
  if (!ENABLED) return;
  for (const key of [...G.reported.keys()]) if (key === id || key.startsWith(`${id}/`)) G.reported.delete(key);
  try {
    writeTerminalSequence(`${OSC}state=clear:id=${id}${ST}`);
  } catch {}
}

/** The first line a person would call the task: no blank lines, headings, rules or omp's assignment boilerplate. */
export function firstMeaningfulLine(text: string | undefined): string {
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || /^#{1,6}\s/.test(line) || /^[-*_=]{3,}$/.test(line) || /^```/.test(line)) continue;
    if (/^complete (the )?assignment( thoroughly)?[:.]?$/i.test(line)) continue;
    return line.replace(/^[-*+]\s+|^\d+[.)]\s+/, "").replace(/^\*\*(.+)\*\*$/, "$1");
  }
  return "";
}

/** The record id of a subagent transcript: its path under the root's artifacts directory, segment by segment. */
function recordId(sessionFile: string | undefined, fallbackParent: string | null, name: string | undefined): string | null {
  let rel: string | null = null;
  if (G.root && sessionFile) {
    const base = G.root.replace(/\.jsonl$/, "");
    const file = sessionFile.replace(/\.jsonl$/, "");
    if (file.startsWith(`${base}${path.sep}`)) rel = file.slice(base.length + 1);
  }
  if (!rel && name) rel = fallbackParent ? `${fallbackParent}/${name}` : name;
  if (!rel) return null;
  const segments = rel.split(path.sep).join("/").split("/").map((s) => s.replace(/[^A-Za-z0-9_.+-]/g, "_").slice(0, 32));
  if (!segments.length || segments.length > MAX_DEPTH || segments.some((s) => !SEGMENT.test(s)) || segments[0].startsWith("_")) return null;
  return segments.join("/");
}

/** The subagent path of a session file (null for the root itself or a file outside its tree). */
function ownPath(sessionFile: string | undefined): string | null {
  if (!G.root || !sessionFile || sessionFile === G.root) return null;
  return recordId(sessionFile, null, undefined);
}

function sendSession(): void {
  if (!G.root) return;
  const msg = b64(G.root, MSG_MAX_BYTES);
  if (msg) write("_session", `state=idle:id=_session:app=omp:msg=${msg}`);
}

/** A new root session: the old one's subagent records go, then `_session` names the new transcript. */
function adoptRoot(file: string | undefined): void {
  if (!file || file === G.root) {
    if (file) sendSession();
    return;
  }
  if (G.root) for (const id of [...G.reported.keys()]) if (id !== "_session" && !id.includes("/")) clear(id);
  G.root = file;
  G.tasks.clear();
  G.reported.delete("_session");
  sendSession();
}

/** The parts of omp's ExtensionAPI and contexts this extension reads; omp's own types live in its binary. */
type SessionCtx = {
  agentKind?: unknown;
  sessionManager?: { getSessionFile?: () => string | undefined; getHeader?: () => { parentSession?: unknown } | undefined };
};
type Api = {
  on(event: string, handler: (event: unknown, ctx: SessionCtx) => void): void;
  events?: { on?: (channel: string, handler: (data: unknown) => void) => unknown };
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

function lifecycle(data: unknown): Lifecycle | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  const status = d.status;
  if (status !== "started" && status !== "completed" && status !== "failed" && status !== "aborted") return null;
  return { id: str(d.id), agent: str(d.agent), status, description: str(d.description), sessionFile: str(d.sessionFile) };
}

export default function lstackHerdrTree(pi: Api): void {
  let mySession: string | undefined;

  const remember = (ctx: SessionCtx) => {
    const sm = ctx?.sessionManager;
    mySession = str(sm?.getSessionFile?.());
    const header = sm?.getHeader?.();
    // A task child: omp says so, or its transcript sits in the root's artifacts directory. A /fork has a parent too,
    // but lives beside the root, so it becomes the new root.
    const sub = ctx?.agentKind === "sub" || (typeof header?.parentSession === "string" && ownPath(mySession) !== null);
    if (!sub) adoptRoot(mySession);
  };

  pi.on("session_start", (_event, ctx) => remember(ctx));
  pi.on("session_switch", (_event, ctx) => remember(ctx));
  pi.on("session_branch", (_event, ctx) => remember(ctx));

  // The task tool's own arguments carry the full task text; the lifecycle event only has a short description.
  pi.on("tool_call", (event) => {
    const e = event as { toolName?: unknown; input?: { tasks?: unknown } } | null;
    if (e?.toolName !== "task" || !Array.isArray(e.input?.tasks)) return;
    for (const t of e.input.tasks as Array<Record<string, unknown> | null>) {
      const name = str(t?.name) ?? str(t?.id);
      const task = str(t?.task);
      if (name && task) G.tasks.set(`${mySession ?? ""}\0${name}`, task);
    }
  });

  pi.events?.on?.("task:subagent:lifecycle", (data) => {
    const p = lifecycle(data);
    if (!p) return;
    const id = recordId(p.sessionFile, ownPath(mySession), p.id);
    if (!id) return;
    // A nested child is `<parent>.<name>` to omp; people named it `<name>`.
    const name = (p.id ?? id.split("/").pop() ?? id).split(".").pop() ?? id;
    const state = p.status === "started" ? "working" : p.status === "completed" ? "done" : "error";
    const title = b64([p.agent, name, state === "error" ? p.status : null].filter(Boolean).join(" · "), TITLE_MAX_BYTES);
    // The task text came from the parent's task call: the parent session sits beside the child's artifacts dir.
    const parent = p.sessionFile ? `${path.dirname(p.sessionFile)}.jsonl` : mySession;
    const task = G.tasks.get(`${parent ?? ""}\0${name}`) ?? G.tasks.get(`${mySession ?? ""}\0${name}`);
    const msg = b64(firstMeaningfulLine(task) || firstMeaningfulLine(p.description) || "", MSG_MAX_BYTES);
    write(id, `state=${state}:id=${id}:app=omp${title ? `:title=${title}` : ""}${msg ? `:msg=${msg}` : ""}`);
  });
}
