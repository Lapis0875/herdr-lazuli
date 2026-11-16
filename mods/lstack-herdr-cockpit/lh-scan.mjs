#!/usr/bin/env node
// The call tree's reader of omp session transcripts, run by the mod through `exec` (a mod can only read whole files;
// transcripts grow to megabytes). Files are read incrementally: each one's summary and byte offset are kept in
// ~/.cache/lstack-herdr/scan-cache.json, so a run reads only what was appended since the last.
//
//   node lh-scan.mjs tree '<json>'        {roots:[{key, session?, pid?}]} → {roots:{key:{session, est, nodes:[...]}}}
//   node lh-scan.mjs transcript <file> <offset>   → {offset, size, items:[...]} entries appended after offset
//   node lh-scan.mjs run '<json>'         {session, run?: index|null, records?: {id: state}} → one run, bounded (below)
//   node lh-scan.mjs call '<json>'        {file, id} → one call's arguments, result or error, model/tool split
//
// A root without a session (no lstack-herdr-tree extension in that omp) is found the way omp itself marks it:
// foreground pid → its tty → ~/.omp/agent/terminal-sessions/<tty> (cwd, session path, cwdstat <dev> <ino>), the cwd's
// identity checked, so a reused tty never names another terminal's session. Such a root is `est` (추정).

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";

const CACHE_DIR = path.join(os.homedir(), ".cache", "lstack-herdr");
const CACHE = path.join(CACHE_DIR, "scan-cache.json");
const CACHE_VERSION = 5;
const RESULT_CHARS = 4000;
const TEXT_CHARS = 16000;
const LINE_CHARS = 200;
const MAX_NODES = 300;
const ITEM_CHARS = 6000;
const MAX_ITEMS = 300;
const BOILERPLATE = /^complete (the )?assignment( thoroughly)?[:.]?\s*\n+/i;

function loadCache() {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE, "utf8"));
    if (c.version === CACHE_VERSION) return c;
  } catch {}
  return { version: CACHE_VERSION, files: {} };
}

function saveCache(cache, used) {
  // After a tree, files no longer asked about drop out, so the cache stays the size of what is shown.
  if (used) for (const f of Object.keys(cache.files)) if (!used.has(f)) delete cache.files[f];
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = `${CACHE}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(cache));
  fs.renameSync(tmp, CACHE);
}

const text = (content) =>
  Array.isArray(content) ? content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n") : typeof content === "string" ? content : "";

/** Reads `file` from its cached offset to the end, a whole line at a time, into its summary. */
function summarize(cache, file) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  let s = cache.files[file];
  if (!s || st.size < s.offset || st.ino !== s.ino) {
    s = { ino: st.ino, offset: 0, start: null, end: null, workEnd: null, init: null, header: null, last: null, stopError: null, stopAborted: false, exited: false, tasks: {}, jobs: {}, calls: {} };
  }
  s.mtime = st.mtimeMs;
  if (st.size > s.offset) {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(st.size - s.offset);
      fs.readSync(fd, buf, 0, buf.length, s.offset);
      const end = buf.lastIndexOf(10);
      if (end >= 0) {
        for (const line of buf.subarray(0, end).toString("utf8").split("\n")) if (line) take(s, line);
        s.offset += end + 1;
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  cache.files[file] = s;
  return s;
}

/** One transcript entry into a file's summary: its timing, task, children's calls and their outcomes, its result. */
function take(s, line) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  const ts = o.timestamp ? Date.parse(o.timestamp) : NaN;
  if (Number.isFinite(ts)) {
    s.start ??= ts;
    s.end = ts;
  }
  if (o.type === "session") s.header = { parent: o.parentSession ?? null, cwd: o.cwd ?? null };
  if (o.type === "session_init") s.init = { task: typeof o.task === "string" ? o.task : "", agent: o.agent ?? null };
  if (o.type === "custom" && o.customType === "session_exit") {
    s.exited = true;
    const at = Date.parse(o.data?.recordedAt ?? "");
    if (Number.isFinite(at)) s.end = at;
  } else if (o.type === "message") {
    // A revived subagent writes on after its exit: this run starts here.
    if (s.exited && Number.isFinite(ts)) s.resumeAt = ts;
    s.exited = false;
    // Its work ends with its last message; a cancelled child is disposed (session_exit) much later.
    if (Number.isFinite(ts)) s.workEnd = ts;
  }
  const m = o.message;
  if (o.type === "message" && m?.role === "assistant") {
    const t = text(m.content).trim();
    if (t) s.last = t.slice(0, RESULT_CHARS);
    s.stopError = m.stopReason === "error" ? String(m.errorMessage ?? "error").slice(0, 400) : null;
    s.stopAborted = m.stopReason === "aborted";
    s.abortReason = s.stopAborted ? String(m.errorMessage ?? "aborted").slice(0, 400) : null;
    for (const c of m.content ?? []) {
      if (c?.type !== "toolCall" || c.name !== "task" || !Array.isArray(c.arguments?.tasks)) continue;
      s.calls[c.id] = { context: typeof c.arguments.context === "string" ? c.arguments.context : "", tasks: c.arguments.tasks.map((t) => ({ name: t?.name ?? t?.id ?? null, agent: t?.agent ?? null, task: t?.task ?? "" })) };
    }
  }
  if (o.type === "message" && m?.role === "toolResult") {
    const d = m.details ?? {};
    // The task tool's result names each child by the id omp gave it (nested: "<parent>.<name>").
    if (m.toolName === "task" && Array.isArray(d.progress)) {
      const call = s.calls[m.toolCallId];
      for (const p of d.progress) {
        if (!p?.id) continue;
        const t = call?.tasks?.[p.index ?? -1] ?? call?.tasks?.find((x) => x.name === p.id || p.id.endsWith(`.${x.name}`));
        s.tasks[p.id] = { agent: p.agent ?? t?.agent ?? null, task: p.assignment ?? t?.task ?? "", context: call?.context ?? "" };
        if (p.status && p.status !== "pending" && p.status !== "running") s.jobs[p.id] = { status: p.status, durationMs: p.durationMs ?? null, at: ts };
      }
    }
    for (const j of Array.isArray(d.jobs) ? d.jobs : []) job(s, j, ts);
  }
  if (o.type === "custom_message" && Array.isArray(o.details?.jobs)) for (const j of o.details.jobs) job(s, j, ts);
}

function job(s, j, ts) {
  const id = j?.id ?? j?.jobId ?? j?.agentId;
  if (!id || j.type && j.type !== "task") return;
  const prev = s.jobs[id];
  // A later "running" snapshot never undoes an outcome already seen.
  if (j.status === "running" && prev && prev.status !== "running") return;
  s.jobs[id] = { status: j.status ?? prev?.status ?? null, durationMs: j.durationMs ?? prev?.durationMs ?? null, error: j.errorText ?? j.error ?? prev?.error ?? null, at: j.status !== prev?.status ? ts : prev?.at ?? ts };
}

function childFiles(base, rel = "") {
  let entries;
  try {
    entries = fs.readdirSync(path.join(base, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (e.isFile() && e.name.endsWith(".jsonl")) out.push(rel ? `${rel}/${e.name.slice(0, -6)}` : e.name.slice(0, -6));
  }
  for (const e of entries) if (e.isDirectory()) out.push(...childFiles(base, rel ? `${rel}/${e.name}` : e.name));
  return out;
}

/** The session a root's omp shows, from omp's tty breadcrumb, or null when nothing proves it. */
function sessionOfPid(pid) {
  try {
    const tty = execFileSync("ps", ["-o", "tty=", "-p", String(pid)], { encoding: "utf8" }).trim();
    if (!tty || tty === "??") return null;
    const crumb = fs.readFileSync(path.join(os.homedir(), ".omp", "agent", "terminal-sessions", path.basename(tty)), "utf8").split("\n");
    const [cwd, session, stat] = crumb;
    const m = /^cwdstat (\d+) (\d+)/.exec(stat ?? "");
    if (!cwd || !session || !m) return null;
    const st = fs.statSync(cwd);
    if (String(st.dev) !== m[1] || String(st.ino) !== m[2]) return null;
    return fs.existsSync(session) ? session : null;
  } catch {
    return null;
  }
}

const strip = (task) => String(task ?? "").replace(BOILERPLATE, "").trim();

/** A child transcript's place in its tree: its parent's task call and the outcome the parent saw. */
function childFacts(cache, base, id, summaries) {
  const file = `${base}/${id}.jsonl`;
  const s = summarize(cache, file);
  if (!s) return null;
  summaries?.set(id, s);
  const parentId = id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "";
  const parent = summaries?.get(parentId) ?? summarize(cache, parentId ? `${base}/${parentId}.jsonl` : `${base}.jsonl`);
  const stem = id.split("/").pop();
  const call = parent?.tasks?.[stem];
  const outcome = parent?.jobs?.[stem];
  // An outcome counts until the child writes again after it (revived, or resumed by a message). Without one, the
  // child's own last stop says it: an error is failed, a cancelled request (its job killed) aborted.
  const revived = Boolean(outcome?.status && outcome.status !== "running" && !s.exited && s.end > (outcome.at ?? 0) + 2000);
  const status = revived
    ? "running"
    : outcome?.status && outcome.status !== "running"
      ? outcome.status
      : s.stopError
        ? "failed"
        : s.stopAborted
          ? "aborted"
          : outcome?.status === "running" || !s.exited
            ? "running"
            : "unknown";
  return { file, s, call, outcome, revived, status, stem };
}

/** The first line a person would call a task: no headings, rules or omp's assignment boilerplate. */
function firstLine(text) {
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.trim();
    if (!line || /^#{1,6}\s/.test(line) || /^[-*_=]{3,}$/.test(line) || /^```/.test(line) || BOILERPLATE.test(`${line}\n`)) continue;
    return line.replace(/^[-*+]\s+|^\d+[.)]\s+/, "").slice(0, LINE_CHARS);
  }
  return "";
}

/** Each root's tree, brief: names, types, statuses, times and first lines; prompts and results come per node. */
function tree(input) {
  const cache = loadCache();
  const used = new Set();
  const roots = {};
  for (const r of input.roots ?? []) {
    const est = !r.session;
    const session = r.session ?? (r.pid ? sessionOfPid(r.pid) : null);
    if (!session) {
      roots[r.key] = { session: null, est, nodes: [] };
      continue;
    }
    used.add(session);
    const root = summarize(cache, session);
    const base = session.replace(/\.jsonl$/, "");
    const summaries = new Map([["", root]]);
    const nodes = [];
    for (const id of childFiles(base).slice(0, MAX_NODES)) {
      used.add(`${base}/${id}.jsonl`);
      const f = childFacts(cache, base, id, summaries);
      if (!f) continue;
      const { s, call, outcome, revived, status, stem, file } = f;
      nodes.push({
        id,
        file,
        name: stem.split(".").pop(),
        agent: s.init?.agent ?? call?.agent ?? null,
        line: firstLine(call?.task || s.init?.task),
        start: revived ? s.resumeAt ?? outcome.at ?? s.start : s.start,
        end: status === "running" ? null : s.workEnd ?? s.end,
        status,
        durationMs: status === "running" ? null : outcome?.durationMs ?? (s.start && (s.workEnd ?? s.end) ? (s.workEnd ?? s.end) - s.start : null),
      });
    }
    roots[r.key] = { session, est, start: root?.start ?? null, nodes };
  }
  saveCache(cache, used);
  return { roots };
}

/** One node's whole story: the task it was given, the context shared with its siblings, its result or failure. */
function detail(session, id) {
  const cache = loadCache();
  const f = childFacts(cache, session.replace(/\.jsonl$/, ""), id, null);
  saveCache(cache, null);
  if (!f) return { error: `no transcript for ${id}` };
  const clip = (t, n) => (t.length > n ? `${t.slice(0, n)}…` : t);
  return {
    task: clip(strip(f.call?.task || f.s.init?.task), TEXT_CHARS),
    context: clip(f.call?.context ?? "", TEXT_CHARS),
    result: clip(f.s.last ?? "", RESULT_CHARS),
    failure: f.outcome?.error ?? f.s.stopError ?? (f.status === "aborted" ? f.s.abortReason ?? "aborted" : null),
    status: f.status,
  };
}

/** The entries appended to a transcript after `offset`, as the viewer shows them: messages, tool calls, results. */
function transcript(file, offset) {
  const st = fs.statSync(file);
  const from = offset > st.size ? 0 : offset;
  const items = [];
  if (st.size <= from) return { offset: from, size: st.size, items, reset: from !== offset };
  const fd = fs.openSync(file, "r");
  let next = from;
  try {
    const buf = Buffer.alloc(st.size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    const end = buf.lastIndexOf(10);
    if (end < 0) return { offset: from, size: st.size, items };
    next = from + end + 1;
    for (const line of buf.subarray(0, end).toString("utf8").split("\n")) {
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = o.timestamp ? Date.parse(o.timestamp) : null;
      const m = o.message;
      if (o.type === "session_init") items.push({ kind: "task", ts, text: strip(o.task).slice(0, TEXT_CHARS), agent: o.agent ?? null });
      else if (o.type === "message" && m?.role === "assistant") {
        const t = text(m.content).trim();
        if (t) items.push({ kind: "assistant", ts, text: t.slice(0, ITEM_CHARS) });
        for (const c of m.content ?? []) if (c?.type === "toolCall") items.push({ kind: "tool", ts, id: c.id, tool: c.name, arg: toolArg(c.name, c.arguments), intent: c.arguments?.i ?? null });
        if (m.stopReason === "error") items.push({ kind: "error", ts, text: String(m.errorMessage ?? "error").slice(0, ITEM_CHARS) });
      } else if (o.type === "message" && m?.role === "toolResult") items.push({ kind: "result", ts, id: m.toolCallId, tool: m.toolName, ok: !m.isError, text: text(m.content).slice(0, 400) });
      else if (o.type === "message" && m?.role === "user") {
        // The first user message is the task again, with omp's boilerplate; later ones are messages to the agent.
        const t = text(m.content).trim();
        if (t && !items.some((i) => i.kind === "task" && i.text === strip(t).slice(0, TEXT_CHARS))) items.push({ kind: "user", ts, text: t.slice(0, 2000) });
      } else if (o.type === "custom" && o.customType === "session_exit") items.push({ kind: "exit", ts, text: o.data?.reason ?? "" });
    }
  } finally {
    fs.closeSync(fd);
  }
  // The viewer keeps the task and the latest MAX_ITEMS entries; a first read of a long transcript sends no more.
  const kept = items.length > MAX_ITEMS ? [...items.filter((i) => i.kind === "task").slice(0, 1), ...items.slice(-MAX_ITEMS)] : items;
  return { offset: next, size: st.size, items: kept, dropped: items.length > MAX_ITEMS ? items.length - MAX_ITEMS : 0, reset: from !== offset };
}

/** A tool call's one line: its path, command or pattern, else its arguments shortened. */
function toolArg(name, a) {
  if (!a || typeof a !== "object") return "";
  const pick = a.path ?? a.command ?? a.pattern ?? a.query ?? a.url ?? (Array.isArray(a.tasks) ? a.tasks.map((t) => t?.name).filter(Boolean).join(", ") : null);
  if (typeof pick === "string") return pick.replace(/\s+/g, " ").slice(0, 300);
  const rest = Object.entries(a).filter(([k]) => k !== "i").map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
  return rest.replace(/\s+/g, " ").slice(0, 300);
}

// ---------------------------------------------------------------------------------------------------------------------
// Runs (the Run Inspector). A run is one user message in the root session and everything until the agent delivered
// its final output: it runs while the root works (a call or a model reply in flight) or a job it started has not been
// delivered back; it is finished once the root replied with nothing pending, however long the session then idles.
// Each file is folded incrementally (byte offset, like the tree's cache) into bounded per-run aggregates: counts,
// cost, tokens, the last steps, the last failures, what it spawned. Nothing here keeps transcript text beyond labels.

const RUN_CACHE = path.join(CACHE_DIR, "run-cache.json");
const RUN_CACHE_VERSION = 3;
const ROWS = 5;
const TAIL = 8;
const LABEL = 80;
const DONE = new Set(["completed", "done", "failed", "aborted", "cancelled"]);

function loadRunCache() {
  try {
    const c = JSON.parse(fs.readFileSync(RUN_CACHE, "utf8"));
    if (c.version === RUN_CACHE_VERSION) return c;
  } catch {}
  return { version: RUN_CACHE_VERSION, files: {} };
}

function saveRunCache(c) {
  // The 64 files read last stay; the rest drop out.
  const keys = Object.keys(c.files).sort((a, b) => (c.files[b].used ?? 0) - (c.files[a].used ?? 0));
  for (const k of keys.slice(64)) delete c.files[k];
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const tmp = `${RUN_CACHE}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(c));
  fs.renameSync(tmp, RUN_CACHE);
}

// A message typed by `hc send` arrives wrapped in <hc from="tN">…</hc> (hc's notes); the title is what it says.
const oneLine = (t) => String(t ?? "").replace(/<\/?hc\b[^>]*>/g, "").trim().replace(/\s*\n+\s*/g, " · ");
const clipTo = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** "429 rate_limit_error — message (다시 시도: 10h 38m 후)" for a provider's JSON error; other errors as they are. */
function normalizeError(raw) {
  const s = String(raw ?? "").trim();
  const m = /^(\d{3})\s+(\{.*\})(?:\s+retry-after-ms=(\d+))?\s*$/s.exec(s);
  if (m) {
    try {
      const e = JSON.parse(m[2]).error ?? {};
      const wait = m[3] ? Number(m[3]) / 1000 : null;
      const after = wait == null ? "" : ` (다시 시도: ${wait >= 3600 ? `${Math.floor(wait / 3600)}h ${Math.floor((wait % 3600) / 60)}m` : `${Math.ceil(wait / 60)}m`} 후)`;
      return clipTo(`${m[1]} ${e.type ?? "error"} — ${e.message ?? ""}${after}`, 300);
    } catch {}
  }
  return clipTo(oneLine(s), 300);
}

const newSeg = (at, task) => ({ at, task, s: null, e: null, stop: null, model: null, cost: 0, tok: 0, llm: 0, tools: 0, replies: 0, errs: 0, steps: [], errTail: [], spawned: [], last: at, kind: at == null ? null : "user", stopErr: null, replyAt: null });

/** One entry into a file's run fold. `split`: the root, where user messages start runs; a child is one run. */
function foldRun(r, line, split) {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  const ts = o.timestamp ? Date.parse(o.timestamp) : null;
  const m = o.message;
  if (o.type === "session_init") r.init = { agent: o.agent ?? null, task: firstLine(o.task) };
  if (o.type === "custom" && o.customType === "session_exit") {
    r.exitAt = ts;
    // Every exit of the process (a quit, or before a resume): the jobs it had started died with it.
    r.exits = [...(r.exits ?? []), ts].slice(-50);
  }
  if (split && o.type === "message" && m?.role === "user") {
    r.segs.push(newSeg(ts, clipTo(oneLine(text(m.content)), 200)));
    return;
  }
  if (!r.segs.length) r.segs.push(newSeg(null, ""));
  const seg = r.segs.at(-1);
  if (o.type === "custom" && o.customType === "tool_execution_start") {
    const st = seg.steps.findLast((x) => x.id === o.data?.toolCallId);
    if (st) st.x = Date.parse(o.data.startedAt) || null;
    return;
  }
  if (o.type === "message" && m?.role === "assistant") {
    const start = typeof m.timestamp === "number" ? m.timestamp : ts;
    const end = m.completedAt ?? ts;
    const u = m.usage ?? {};
    seg.s ??= start;
    seg.e = Math.max(seg.e ?? 0, end);
    seg.stop = m.stopReason ?? null;
    seg.model = m.model ?? seg.model;
    seg.cost += u.cost?.total ?? 0;
    seg.tok += u.totalTokens ?? 0;
    seg.llm += 1;
    const failed = m.stopReason === "error" || m.stopReason === "aborted";
    seg.stopErr = failed ? normalizeError(m.errorMessage ?? m.stopReason) : null;
    const calls = (m.content ?? []).filter((c) => c?.type === "toolCall");
    for (const c of calls) {
      const a = c.arguments ?? {};
      seg.tools += 1;
      seg.steps.push({ id: c.id, t: c.name, l: clipTo(String(c.intent || a.i || toolArg(c.name, a) || c.name), LABEL), s: start, me: end, x: null, e: null });
      if (c.name === "task") for (const t of Array.isArray(a.tasks) ? a.tasks : []) if (seg.spawned.length < MAX_NODES) seg.spawned.push({ id: t?.name ?? t?.id, agent: t?.agent ?? null, task: firstLine(t?.task), at: start });
    }
    if (!calls.length) {
      // A model call that calls no tool (a reply, a report, a failure) is a step of its own.
      seg.replies += 1;
      const label = m.stopReason === "aborted" ? "요청 중단됨" : m.stopReason === "error" ? "모델 호출 실패" : clipTo(firstLine(text(m.content)).replace(/\*\*/g, "") || "응답", LABEL);
      const st = { id: `llm-${start}`, t: "model", l: label, s: start, me: end, x: null, e: end, err: failed || undefined };
      seg.steps.push(st);
      if (failed) seg.errTail = [...seg.errTail, st].slice(-2);
    }
    seg.last = Math.max(seg.last ?? 0, end);
    seg.kind = calls.length ? "call" : "reply";
    if (!calls.length && m.stopReason === "stop") seg.replyAt = end;
  } else if (o.type === "message" && m?.role === "toolResult") {
    const st = seg.steps.findLast((x) => x.id === m.toolCallId);
    if (st) {
      st.e = ts;
      if (m.isError) {
        st.err = true;
        seg.errs += 1;
        seg.errTail = [...seg.errTail, { ...st }].slice(-2);
      }
    }
    const d = m.details ?? {};
    if (m.toolName === "task" && Array.isArray(d.progress)) {
      // The ids omp gave the children (nested: "<parent>.<name>"), which name their transcripts.
      for (const p of d.progress) {
        if (!p?.id) continue;
        const sp = seg.spawned.find((x) => x.id === p.id || p.id.endsWith(`.${x.id}`)) ?? (seg.spawned.length < MAX_NODES ? (seg.spawned.push({ id: p.id, agent: p.agent ?? null, task: "", at: ts }), seg.spawned.at(-1)) : null);
        if (sp) sp.id = p.id;
        if (p.status && p.status !== "pending" && p.status !== "running") runJob(r, { agentId: p.id, type: "task", status: p.status }, ts);
      }
    }
    for (const j of Array.isArray(d.jobs) ? d.jobs : []) runJob(r, j, ts);
    seg.last = Math.max(seg.last ?? 0, ts);
    seg.kind = "result";
  } else if (o.type === "custom_message" && Array.isArray(o.details?.jobs)) {
    for (const j of o.details.jobs) runJob(r, j, ts);
    seg.last = Math.max(seg.last ?? 0, ts);
    seg.kind = "async";
  } else return;
  // Bounded: the last TAIL steps, plus any still open (a call in flight never drops out).
  while (seg.steps.length > TAIL) {
    const i = seg.steps.findIndex((x) => x.e != null);
    if (i < 0) break;
    seg.steps.splice(i, 1);
  }
}

function runJob(r, j, ts) {
  if (j?.type && j.type !== "task") return;
  const id = j?.agentId ?? j?.id;
  if (!id) return;
  const prev = r.jobs[id];
  if (j.status === "running" && prev && DONE.has(prev.status)) return;
  r.jobs[id] = { status: j.status ?? prev?.status ?? null, at: ts };
}

/** A file's run fold, read from its cached offset to the end. */
function runFold(c, file, split) {
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  const key = `${split ? "root" : "child"}:${file}`;
  let r = c.files[key];
  if (!r || st.size < r.offset || st.ino !== r.ino) r = { ino: st.ino, offset: 0, segs: [], jobs: {}, init: null, exitAt: null, exits: [] };
  if (st.size > r.offset) {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(st.size - r.offset);
      fs.readSync(fd, buf, 0, buf.length, r.offset);
      const end = buf.lastIndexOf(10);
      if (end >= 0) {
        for (const line of buf.subarray(0, end).toString("utf8").split("\n")) if (line) foldRun(r, line, split);
        r.offset += end + 1;
      }
    } finally {
      fs.closeSync(fd);
    }
  }
  r.used = Date.now();
  c.files[key] = r;
  return r;
}

// A live OSC record's state (the extension's report) wins over the transcript's guess.
const RECORD = { working: "running", blocked: "blocked", done: "done", idle: "done", failed: "failed", aborted: "aborted" };

/** A card: one agent's part of the run, its rows placed inside its own lifetime. */
function runCard(seg, { id, parent, depth, name, agent, task, file, status, now }) {
  const first = Math.min(seg.at ?? Infinity, seg.s ?? Infinity, ...seg.steps.map((x) => x.s));
  const start = Number.isFinite(first) ? first : now;
  const live = status === "running" || status === "blocked";
  const end = live ? now : Math.max(seg.last ?? start, seg.e ?? start);
  const life = Math.max(1, end - start);
  const steps = [...seg.steps];
  // Between a result and the next message a model reply is being written that no transcript holds yet.
  if (live && !steps.some((x) => x.e == null) && seg.kind !== "reply" && seg.last) steps.push({ id: `live-${seg.last}`, t: "model", l: "모델 응답 중", s: seg.last, e: null });
  const pinned = seg.errTail.filter((x) => !steps.slice(-ROWS).some((y) => y.id === x.id));
  const latest = steps.slice(-(ROWS - pinned.length));
  const shown = [...pinned, ...latest].sort((a, b) => a.s - b.s);
  const rows = shown.map((x) => {
    const e = x.e ?? now;
    return {
      id: x.id, tool: x.t, label: x.l,
      at: +Math.max(0, Math.min(1, (x.s - start) / life)).toFixed(4),
      len: +Math.max(0, Math.min(1, (e - x.s) / life)).toFixed(4),
      ms: Math.max(0, e - x.s),
      toolMs: x.x && x.e ? Math.max(0, x.e - x.x) : null,
      ...(x.e == null ? { running: true } : {}),
      ...(x.err ? { err: true } : {}),
    };
  });
  const total = seg.tools + seg.replies;
  return {
    id, parent, depth, name, agent, file, status, task,
    model: modelLabel(seg.model), start, end: live ? null : end, ms: end - start,
    cost: +seg.cost.toFixed(4), tokens: seg.tok, modelCalls: seg.llm, toolCalls: seg.tools, errors: seg.errs + (seg.stopErr ? 1 : 0),
    error: seg.stopErr, rows, more: Math.max(0, total - rows.filter((x) => !x.id.startsWith("live-")).length),
  };
}

/** "GPT-6 Astra", "Opus 5.5" from omp's model ids. */
function modelLabel(id) {
  if (!id) return null;
  let m = /^claude-(opus|sonnet|haiku)-(\d+)-(\d+)/.exec(id);
  if (m) return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
  m = /^gpt-([\d.]+)(?:-(.+))?$/.exec(id);
  if (m) return `GPT-${m[1]}${m[2] ? ` ${m[2].split("-").map((w) => w[0].toUpperCase() + w.slice(1)).join(" ")}` : ""}`;
  return clipTo(id, 24);
}

/**
 * Whether an omp process still holds this session: omp's tty breadcrumb names it and an omp runs on that tty. The
 * mod asks with `alive` already known (it only shows roots of live terminals); this is for any other caller.
 */
function sessionAlive(session) {
  const dir = path.join(os.homedir(), ".omp", "agent", "terminal-sessions");
  let ttys = [];
  try {
    ttys = fs.readdirSync(dir);
  } catch {
    return false;
  }
  for (const tty of ttys) {
    try {
      if (fs.readFileSync(path.join(dir, tty), "utf8").split("\n")[1] !== session) continue;
      if (/(^|\/)omp\s*$/m.test(execFileSync("ps", ["-t", tty, "-o", "comm="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }))) return true;
    } catch {}
  }
  return false;
}

/**
 * One run of a root: its numbers, and the cards of the root and every agent the run started (≤ MAX_NODES).
 * Subagents live in the root's process: once it is gone (no live process holds the session, or it exited after a
 * job started) an undelivered job can never come back, so it reads 중단 and the run is over, however it ended.
 */
function run(input) {
  const c = loadRunCache();
  const now = Date.now();
  const session = input.session;
  const records = input.records ?? {};
  const root = runFold(c, session, true);
  if (!root) throw new Error(`no transcript at ${session}`);
  const runs = root.segs.filter((x) => x.at != null);
  const count = runs.length;
  if (!count) {
    saveRunCache(c);
    return { run: { index: 0, count: 0 }, cards: [] };
  }
  const index = Number.isInteger(input.run) && input.run >= 0 && input.run < count ? input.run : count - 1;
  const seg = runs[index];
  const cards = [];
  let truncated = 0;
  const pending = [];
  const alive = typeof input.alive === "boolean" ? input.alive : sessionAlive(session);
  // A job is lost when the process that ran it is gone: no live root, or the root exited after starting it.
  const lost = (at) => !alive || (root.exits ?? []).some((x) => x >= (at ?? 0));
  let cut = 0;
  // Children depth-first, the order their parent started them; a nested child's transcript is <parent stem>.<name>.
  const walk = (dir, stem, parentId, depth, parentFold, spawned) => {
    const seen = new Set();
    for (const sp of spawned) {
      if (!sp.id || seen.has(sp.id)) continue;
      seen.add(sp.id);
      if (cards.length >= MAX_NODES) {
        truncated += 1;
        continue;
      }
      const fileStem = sp.id.includes(".") || !stem ? sp.id : `${stem}.${sp.id}`;
      const file = path.join(dir, `${fileStem}.jsonl`);
      const ch = runFold(c, file, false);
      if (!ch?.segs.length) continue;
      const cs = ch.segs[0];
      const id = parentId ? `${parentId}/${fileStem}` : fileStem;
      const job = parentFold.jobs[sp.id] ?? parentFold.jobs[fileStem];
      const rec = records[id];
      let status;
      // An outcome counts until the child writes again after it (revived, e.g. resumed by a message).
      const revived = Boolean(job && DONE.has(job.status) && (cs.last ?? 0) > (job.at ?? 0) + 2000);
      if (rec) status = RECORD[rec] ?? "running";
      else if (job && DONE.has(job.status) && !revived) status = job.status === "completed" || job.status === "done" ? "done" : job.status === "cancelled" ? "aborted" : job.status;
      else if (cs.stop === "error") status = "failed";
      else if (cs.stop === "aborted") status = "aborted";
      else if (cs.kind === "reply" && cs.stop === "stop" && cs.steps.every((x) => x.e != null)) status = "done";
      else status = "running";
      const gone = lost(sp.at);
      if (gone && (status === "running" || status === "blocked")) status = "aborted";
      // Delivered back once the parent saw the job's outcome, or replied after the child ended; until then the run
      // is not over (an async result is still on its way to wake the root), unless its process is gone: then a job
      // that never got back, killed silently or aborted on the way out, cut the run off.
      const childEnd = Math.max(cs.last ?? 0, cs.e ?? 0);
      const delivered = (job && DONE.has(job.status)) || (parentFold === root && seg.replyAt != null && seg.replyAt >= childEnd);
      if (gone && !delivered && status === "aborted") cut += 1;
      if (depth === 1 && !delivered && !gone) pending.push(id);
      if (status === "running" || status === "blocked") pending.push(id);
      cards.push(runCard(cs, { id, parent: parentId, depth, name: fileStem.split(".").pop(), agent: ch.init?.agent ?? sp.agent ?? null, task: sp.task || ch.init?.task || "", file, status, now }));
      const sub = file.replace(/\.jsonl$/, "");
      if (cs.spawned.length) walk(sub, fileStem, id, depth + 1, ch, cs.spawned);
    }
  };
  walk(session.replace(/\.jsonl$/, ""), "", "", 1, root, seg.spawned);
  // The root works while a call or a model reply is in flight in the latest run and its process lives; an ask in
  // flight is blocked. Gone mid-turn in its latest run, it ended aborted (an earlier run ended with the next message).
  const latest = index === count - 1;
  const open = seg.steps.filter((x) => x.e == null);
  const midTurn = open.length > 0 || (seg.kind !== "reply" && seg.kind !== null) || (seg.kind === "reply" && seg.stop !== "stop" && seg.stop !== "error" && seg.stop !== "aborted");
  const rootGone = lost(seg.last ?? seg.at);
  const rootWorking = latest && midTurn && !rootGone;
  const blocked = rootWorking && open.some((x) => x.t === "ask");
  const final = seg.stop === "error" ? "failed" : seg.stop === "aborted" || (latest && midTurn && rootGone) ? "aborted" : "done";
  const status = blocked ? "blocked" : rootWorking || pending.length ? "running" : cut ? "aborted" : final;
  // The root's own part: working in the latest run, waiting on its jobs there, else what it ended that run with.
  const rootStatus = rootWorking ? (blocked ? "blocked" : "running") : latest && pending.length ? "running" : final;
  cards.unshift(runCard(seg, { id: "", parent: null, depth: 0, name: "omp", agent: "omp", task: seg.task, file: session, status: rootStatus, now }));
  saveRunCache(c);
  const sum = (f) => cards.reduce((a, x) => a + (f(x) ?? 0), 0);
  const end = status === "running" || status === "blocked" ? null : Math.max(...cards.map((x) => x.end ?? 0));
  return {
    run: {
      index, count, task: seg.task, status, start: seg.at, end, ms: (end ?? now) - seg.at,
      agents: cards.length, running: cards.filter((x) => x.status === "running" || x.status === "blocked").length,
      cost: +sum((x) => x.cost).toFixed(4), tokens: sum((x) => x.tokens), modelCalls: sum((x) => x.modelCalls),
      toolCalls: sum((x) => x.toolCalls), errors: sum((x) => x.errors),
    },
    cards,
    truncated: { cards: truncated },
  };
}

/** One call of one transcript, when its row is opened: arguments, result or error, and the model/tool split. */
function call(input) {
  const { file, id } = input;
  const short = (v) => clipTo(typeof v === "string" ? v.replace(/\s+/g, " ") : JSON.stringify(v) ?? "", 140);
  let found = null, result = null, started = null;
  const want = id.startsWith("llm-") ? Number(id.slice(4)) : null;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line || !line.includes(want != null ? '"assistant"' : id.split("|")[0])) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const m = o.message;
    if (want != null && m?.role === "assistant" && (m.timestamp ?? Date.parse(o.timestamp)) === want) {
      const failed = m.stopReason === "error" || m.stopReason === "aborted";
      return {
        tool: "model", model: modelLabel(m.model), args: null, isError: failed,
        error: failed ? normalizeError(m.errorMessage ?? m.stopReason) : null,
        result: failed ? null : text(m.content).split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 4).join("\n").slice(0, 400),
        modelMs: (m.completedAt ?? want) - want, toolMs: null,
      };
    }
    if (m?.role === "assistant") {
      const c = (m.content ?? []).find((x) => x?.type === "toolCall" && x.id === id);
      if (c) found = { c, start: m.timestamp ?? Date.parse(o.timestamp), modelEnd: m.completedAt ?? Date.parse(o.timestamp), model: m.model };
    } else if (o.type === "custom" && o.customType === "tool_execution_start" && o.data?.toolCallId === id) started = Date.parse(o.data.startedAt) || null;
    else if (m?.role === "toolResult" && m.toolCallId === id) result = { m, at: m.timestamp ?? Date.parse(o.timestamp) };
  }
  if (!found) return { error: `no call ${id}` };
  const args = Object.entries(found.c.arguments ?? {}).filter(([k]) => k !== "i").slice(0, 8).map(([k, v]) => [k, short(v)]);
  const out = text(result?.m.content ?? "");
  return {
    tool: found.c.name, model: modelLabel(found.model), args: Object.fromEntries(args), isError: Boolean(result?.m.isError),
    error: result?.m.isError ? normalizeError(out.split("\n").filter(Boolean).slice(0, 3).join(" ")) : null,
    result: result && !result.m.isError ? out.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 4).join("\n").slice(0, 400) : null,
    modelMs: found.modelEnd - found.start,
    toolMs: result && started ? result.at - started : null,
    pending: !result,
  };
}

const [cmd, ...rest] = process.argv.slice(2);
try {
  if (cmd === "tree") console.log(JSON.stringify(tree(JSON.parse(rest[0] ?? "{}"))));
  else if (cmd === "detail") console.log(JSON.stringify(detail(rest[0], rest[1])));
  else if (cmd === "transcript") console.log(JSON.stringify(transcript(rest[0], Number(rest[1] ?? 0) || 0)));
  else if (cmd === "run") console.log(JSON.stringify(run(JSON.parse(rest[0] ?? "{}"))));
  else if (cmd === "call") console.log(JSON.stringify(call(JSON.parse(rest[0] ?? "{}"))));
  else throw new Error(`unknown command ${cmd ?? "(none)"}`);
} catch (e) {
  console.log(JSON.stringify({ error: String(e?.message ?? e) }));
  process.exit(1);
}
