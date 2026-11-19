#!/usr/bin/env node
// lazuli's transcript reader, run by the mod through `exec` (a mod reads whole files only, and transcripts grow
// to megabytes) and by herdr-relay's Deno runner on devices (ARCHITECTURE §4.3, §8). It uses only `node:`
// built-ins, `ps`, and `zstd -dc` for compressed Codex rollouts. Every read is incremental where it can be: a
// file's summary and byte offset are kept under ~/.cache/lazuli/, so a run reads only what was appended.
//
//   node scan.mjs tree '<json>'          {roots:[{key, session?, pid?}]} → {roots:{key:{session, est, nodes:[...]}}}
//   node scan.mjs detail <session> <id>  → one node's task, shared context, result or failure
//   node scan.mjs transcript <file> <offset>   → {offset, size, items:[...]} entries appended after offset
//   node scan.mjs run '<json>'           {session, run?: index|null, records?: {id: state}, alive?} → one run, bounded
//   node scan.mjs call '<json>'          {file, id} → one call's arguments, result or error, model/tool split
//   node scan.mjs usage ['<json>']       {now?, roots?, cache?, rates?} → spend of OMP, Claude Code and Codex
//   node scan.mjs sessions ['<json>']    {query?, limit?, roots?, cache?} → past sessions, newest first
//
// The call tree reads omp transcripts. A root without a session (no lazuli-tree extension in that omp) is found
// the way omp itself marks it: foreground pid → its tty → ~/.omp/agent/terminal-sessions/<tty> (cwd, session
// path, cwdstat <dev> <ino>), the cwd's identity checked, so a reused tty never names another terminal's session.
// Such a root is `est` (estimated).
//
// No text here is shown as it is: labels the scanner makes up are codes (`code` on a run row) and a provider's
// retry wait is a number (`retryMs`), so the views word them in the person's language.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import process from "node:process";
import { Buffer } from "node:buffer";
import { execFileSync, spawn } from "node:child_process";
import { ompUsage, claudeUsage, codexTotal, codexDelta, price, summarize } from "../core/spend.js";
import { RATES } from "../core/pricing.js";

const CACHE_DIR = path.join(os.homedir(), ".cache", "lazuli");
const CACHE = path.join(CACHE_DIR, "scan-cache.json");
const CACHE_VERSION = 6;
const RESULT_CHARS = 4000;
const TEXT_CHARS = 16000;
const LINE_CHARS = 200;
const MAX_NODES = 300;
const ITEM_CHARS = 6000;
const MAX_ITEMS = 300;
const BOILERPLATE = /^complete (the )?assignment( thoroughly)?[:.]?\s*\n+/i;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Writes JSON through a temp file and a rename, so a reader never sees half of it. */
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function loadCache() {
  const c = readJson(CACHE);
  return c?.version === CACHE_VERSION ? c : { version: CACHE_VERSION, files: {} };
}

function saveCache(cache, used) {
  // After a tree, files no longer asked about drop out, so the cache stays the size of what is shown.
  if (used) for (const f of Object.keys(cache.files)) if (!used.has(f)) delete cache.files[f];
  writeJson(CACHE, cache);
}

const text = (content) =>
  Array.isArray(content) ? content.filter((c) => c?.type === "text" && typeof c.text === "string").map((c) => c.text).join("\n") : typeof content === "string" ? content : "";

/** Reads `file` from its cached offset to the end, a whole line at a time, into its summary. */
function summarizeFile(cache, file) {
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
    // The root's last process exit: its subagents, which live in that process, ended with it.
    s.lastExit = Number.isFinite(at) ? at : Number.isFinite(ts) ? ts : s.lastExit ?? null;
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
  if (!id || (j.type && j.type !== "task")) return;
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
  const s = summarizeFile(cache, file);
  if (!s) return null;
  summaries?.set(id, s);
  const parentId = id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : "";
  const parent = summaries?.get(parentId) ?? summarizeFile(cache, parentId ? `${base}/${parentId}.jsonl` : `${base}.jsonl`);
  const root = parentId ? summaries?.get("") ?? summarizeFile(cache, `${base}.jsonl`) : parent;
  const stem = id.split("/").pop();
  const call = parent?.tasks?.[stem];
  const outcome = parent?.jobs?.[stem];
  // An outcome counts until the child writes again after it (revived, or resumed by a message). Without one, the
  // child's own last stop says it: an error is failed, a cancelled request (its job killed) aborted.
  const revived = Boolean(outcome?.status && outcome.status !== "running" && !s.exited && s.end > (outcome.at ?? 0) + 2000);
  let status = revived
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
  // Subagents live in the root's process (as the run view reads it): a child that wrote nothing since that process
  // last exited died with it, whatever it last said.
  if (status === "running" && root?.lastExit != null && root.lastExit >= (s.end ?? s.start ?? 0)) status = "aborted";
  return { file, s, call, outcome, revived, status, stem };
}

/** The first line a person would call a task: no headings, rules or omp's assignment boilerplate. */
function firstLine(value) {
  for (const raw of String(value ?? "").split("\n")) {
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
    const root = summarizeFile(cache, session);
    const base = session.replace(/\.jsonl$/, "");
    const summaries = new Map([["", root]]);
    const nodes = [];
    for (const id of childFiles(base).slice(0, MAX_NODES)) {
      used.add(`${base}/${id}.jsonl`);
      const f = childFacts(cache, base, id, summaries);
      // Only omp transcripts (a session header or a subagent's init) are subagents; extensions keep other JSONL
      // files there too (a `changes.jsonl` change log), which never end and would read as running forever.
      if (!f || !(f.s.header || f.s.init)) continue;
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
// Runs (the run view). A run is one user message in the root session and everything until the agent delivered its
// final output: it runs while the root works (a call or a model reply in flight) or a job it started has not been
// delivered back; it is finished once the root replied with nothing pending, however long the session then idles.
// Each file is folded incrementally (byte offset, like the tree's cache) into bounded per-run aggregates: counts,
// cost, tokens, the last steps, the last failures, what it spawned. Nothing here keeps transcript text beyond labels.

const RUN_CACHE = path.join(CACHE_DIR, "run-cache.json");
const RUN_CACHE_VERSION = 4;
const ROWS = 5;
const TAIL = 8;
const LABEL = 80;
const DONE = new Set(["completed", "done", "failed", "aborted", "cancelled"]);

function loadRunCache() {
  const c = readJson(RUN_CACHE);
  return c?.version === RUN_CACHE_VERSION ? c : { version: RUN_CACHE_VERSION, files: {} };
}

function saveRunCache(c) {
  // The 64 files read last stay; the rest drop out.
  const keys = Object.keys(c.files).sort((a, b) => (c.files[b].used ?? 0) - (c.files[a].used ?? 0));
  for (const k of keys.slice(64)) delete c.files[k];
  writeJson(RUN_CACHE, c);
}

// A message typed by `hc send` arrives wrapped in <hc from="tN">…</hc> (hc's notes); the title is what it says.
const oneLine = (t) => String(t ?? "").replace(/<\/?hc\b[^>]*>/g, "").trim().replace(/\s*\n+\s*/g, " · ");
const clipTo = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const PROVIDER_ERROR = /^(\d{3})\s+(\{.*\})(?:\s+retry-after-ms=(\d+))?\s*$/s;

/** "429 rate_limit_error — message" for a provider's JSON error; other errors as they are, on one line. */
function normalizeError(raw) {
  const s = String(raw ?? "").trim();
  const m = PROVIDER_ERROR.exec(s);
  if (m) {
    try {
      const e = JSON.parse(m[2]).error ?? {};
      return clipTo(`${m[1]} ${e.type ?? "error"} — ${e.message ?? ""}`, 300);
    } catch {}
  }
  return clipTo(oneLine(s), 300);
}

/** The wait a provider's error asks for before a retry (`retry-after-ms=`), in ms, or null. */
function retryOf(raw) {
  const m = PROVIDER_ERROR.exec(String(raw ?? "").trim());
  return m?.[3] ? Number(m[3]) : null;
}

const newSeg = (at, task) => ({ at, task, s: null, e: null, stop: null, model: null, cost: 0, tok: 0, llm: 0, tools: 0, replies: 0, errs: 0, steps: [], errTail: [], spawned: [], last: at, kind: at == null ? null : "user", stopErr: null, stopRetry: null, replyAt: null });

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
    seg.stopRetry = failed ? retryOf(m.errorMessage) : null;
    const calls = (m.content ?? []).filter((c) => c?.type === "toolCall");
    for (const c of calls) {
      const a = c.arguments ?? {};
      seg.tools += 1;
      seg.steps.push({ id: c.id, t: c.name, l: clipTo(String(c.intent || a.i || toolArg(c.name, a) || c.name), LABEL), s: start, me: end, x: null, e: null });
      if (c.name === "task") for (const t of Array.isArray(a.tasks) ? a.tasks : []) if (seg.spawned.length < MAX_NODES) seg.spawned.push({ id: t?.name ?? t?.id, agent: t?.agent ?? null, task: firstLine(t?.task), at: start });
    }
    if (!calls.length) {
      // A model call that calls no tool (a reply, a report, a failure) is a step of its own. Its label is the
      // reply's first line; without one the view words its code: aborted, model-failed, reply.
      seg.replies += 1;
      const said = m.stopReason === "aborted" || m.stopReason === "error" ? "" : clipTo(firstLine(text(m.content)).replace(/\*\*/g, ""), LABEL);
      const code = m.stopReason === "aborted" ? "aborted" : m.stopReason === "error" ? "model-failed" : said ? null : "reply";
      const st = { id: `llm-${start}`, t: "model", l: said, c: code, s: start, me: end, x: null, e: end, err: failed || undefined };
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
  if (live && !steps.some((x) => x.e == null) && seg.kind !== "reply" && seg.last) steps.push({ id: `live-${seg.last}`, t: "model", l: "", c: "replying", s: seg.last, e: null });
  const pinned = seg.errTail.filter((x) => !steps.slice(-ROWS).some((y) => y.id === x.id));
  const latest = steps.slice(-(ROWS - pinned.length));
  const shown = [...pinned, ...latest].sort((a, b) => a.s - b.s);
  const rows = shown.map((x) => {
    const e = x.e ?? now;
    return {
      id: x.id, tool: x.t, label: x.l,
      ...(x.c ? { code: x.c } : {}),
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
    error: seg.stopErr, retryMs: seg.stopErr ? seg.stopRetry ?? null : null,
    rows, more: Math.max(0, total - rows.filter((x) => !x.id.startsWith("live-")).length),
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
 * job started) an undelivered job can never come back, so it reads aborted and the run is over, however it ended.
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
      const jb = parentFold.jobs[sp.id] ?? parentFold.jobs[fileStem];
      const rec = records[id];
      let status;
      // An outcome counts until the child writes again after it (revived, e.g. resumed by a message).
      const revived = Boolean(jb && DONE.has(jb.status) && (cs.last ?? 0) > (jb.at ?? 0) + 2000);
      if (rec) status = RECORD[rec] ?? "running";
      else if (jb && DONE.has(jb.status) && !revived) status = jb.status === "completed" || jb.status === "done" ? "done" : jb.status === "cancelled" ? "aborted" : jb.status;
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
      const delivered = (jb && DONE.has(jb.status)) || (parentFold === root && seg.replyAt != null && seg.replyAt >= childEnd);
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
        retryMs: failed ? retryOf(m.errorMessage) : null,
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
  const errLines = out.split("\n").filter(Boolean).slice(0, 3).join(" ");
  return {
    tool: found.c.name, model: modelLabel(found.model), args: Object.fromEntries(args), isError: Boolean(result?.m.isError),
    error: result?.m.isError ? normalizeError(errLines) : null,
    retryMs: result?.m.isError ? retryOf(errLines) : null,
    result: result && !result.m.isError ? out.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 4).join("\n").slice(0, 400) : null,
    modelMs: found.modelEnd - found.start,
    toolMs: result && started ? result.at - started : null,
    pending: !result,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading many transcripts: the three tools' roots, whole lines from a byte offset, and `.jsonl.zst` rollouts through
// `zstd -dc` (Codex compresses finished rollouts; the relay's runner may refuse to start it: then they are skipped).

const TOOL_NAMES = ["omp", "claude", "codex"];
const DEFAULT_ROOTS = {
  omp: path.join(os.homedir(), ".omp", "agent", "sessions"),
  claude: path.join(os.homedir(), ".claude", "projects"),
  codex: path.join(os.homedir(), ".codex", "sessions"),
};
const CHUNK = 8 << 20;
const ZSTD = ["zstd", "/opt/homebrew/bin/zstd", "/usr/local/bin/zstd"];

const expand = (p) => (typeof p === "string" && (p === "~" || p.startsWith("~/")) ? path.join(os.homedir(), p.slice(1)) : p);

/** Each tool's root: the defaults, a string from `roots` instead, or none for a `null`. */
function rootsOf(input) {
  const given = isObj(input.roots) ? input.roots : {};
  const out = {};
  for (const tool of TOOL_NAMES) {
    const v = Object.prototype.hasOwnProperty.call(given, tool) ? given[tool] : DEFAULT_ROOTS[tool];
    if (typeof v === "string" && v) out[tool] = expand(v);
  }
  return out;
}

/** Transcript files under a root, in folders at most `depth` levels below it (files directly in the root are at
 *  level 0): `.jsonl`, and `.jsonl.zst` when `zst`. */
function listFiles(root, { depth = Infinity, zst = false } = {}) {
  const out = [];
  const walk = (dir, level) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (level < depth) walk(p, level + 1);
      } else if (e.isFile() && (e.name.endsWith(".jsonl") || (zst && e.name.endsWith(".jsonl.zst")))) out.push(p);
    }
  };
  walk(root, 0);
  return out;
}

/** Calls `onLine(bytes)` for each whole line of `file` between `offset` and `end`, in order; a line that returns
 *  true stops the read. Returns the offset after the last whole line read. */
function readLines(file, offset, end, onLine) {
  const fd = fs.openSync(file, "r");
  try {
    const chunk = Buffer.allocUnsafe(Math.max(1, Math.min(CHUNK, end - offset)));
    let pos = offset;
    let carry = null;
    let done = offset;
    while (pos < end) {
      const n = fs.readSync(fd, chunk, 0, Math.min(chunk.length, end - pos), pos);
      if (n <= 0) break;
      const buf = carry ? Buffer.concat([carry, chunk.subarray(0, n)]) : chunk.subarray(0, n);
      carry = null;
      pos += n;
      let start = 0;
      let nl;
      while ((nl = buf.indexOf(10, start)) >= 0) {
        const stop = nl > start && onLine(buf.subarray(start, nl)) === true;
        start = nl + 1;
        done = pos - (buf.length - start);
        if (stop) return done;
      }
      if (start < buf.length) carry = Buffer.from(buf.subarray(start));
    }
    return done;
  } finally {
    fs.closeSync(fd);
  }
}

/** The whole lines in the last `bytes` of a file, oldest first (a line cut by the window's start is left out). */
function tailLines(file, size, bytes) {
  const from = Math.max(0, size - bytes);
  const lines = [];
  let first = from > 0;
  readLines(file, from, size, (line) => {
    if (first) first = false;
    else lines.push(line);
  });
  return lines;
}

let zstdBin = null;

/** Streams `zstd -dc file` into `onLine(bytes)` per whole line; a line that returns true stops it. Resolves with
 *  {ok: true} when the stream was read (to its end or the stop), {ok: false, missing} when zstd could not run. */
function zstdLines(file, onLine) {
  const tryBin = (i) =>
    new Promise((resolve) => {
      const bin = zstdBin ?? ZSTD[i];
      let child;
      try {
        child = spawn(bin, ["-dc", "--", file], { stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        resolve({ ok: false, spawnFailed: true });
        return;
      }
      let carry = null;
      let stopped = false;
      let failed = false;
      child.on("error", () => {
        failed = true;
        resolve({ ok: false, spawnFailed: true });
      });
      child.stdout.on("data", (data) => {
        if (stopped) return;
        const buf = carry ? Buffer.concat([carry, data]) : data;
        carry = null;
        let start = 0;
        let nl;
        while ((nl = buf.indexOf(10, start)) >= 0) {
          const stop = nl > start && onLine(buf.subarray(start, nl)) === true;
          start = nl + 1;
          if (stop) {
            stopped = true;
            child.kill();
            return;
          }
        }
        if (start < buf.length) carry = Buffer.from(buf.subarray(start));
      });
      child.on("close", (code) => {
        if (failed) return;
        if (!stopped && carry?.length) onLine(carry);
        zstdBin ??= bin;
        resolve({ ok: stopped || code === 0 });
      });
    });
  return (async () => {
    if (zstdBin) {
      const r = await tryBin(0);
      return r.spawnFailed ? { ok: false, missing: true } : r;
    }
    for (let i = 0; i < ZSTD.length; i++) {
      const r = await tryBin(i);
      if (!r.spawnFailed) return r;
    }
    return { ok: false, missing: true };
  })();
}

const has = (line, needle) => line.indexOf(needle) >= 0;

function parse(line) {
  try {
    return JSON.parse(line.toString("utf8"));
  } catch {
    return null;
  }
}

/** Runs `work(item)` for every item, `limit` at a time. */
async function pool(items, limit, work) {
  let next = 0;
  const lane = async () => {
    while (next < items.length) await work(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

// ---------------------------------------------------------------------------------------------------------------------
// Spend (`usage`). Each file's usage records become entries (core/spend.js), merged per tool, model, recorded-USD or
// not, and quarter hour (every UTC offset is a whole number of quarter hours, so local days split cleanly). Only files
// written since the week's Monday are read; a plain file is read on from its cached offset, a `.zst` again whole when
// it changed. The cache keeps each file's merged rows from the week on.

const USAGE_VERSION = 2;
const SLOT_MS = 15 * 60000;
const FIELDS = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"];
const WANT = {
  omp: (line) => has(line, '"usage"'),
  claude: (line) => has(line, '"usage"') && has(line, '"assistant"'),
  codex: (line) => has(line, '"token_count"') || has(line, '"turn_context"'),
};

function weekStart(now) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime();
}

const freshUsage = (st, from) => ({ ino: st.ino, size: 0, mtime: 0, offset: 0, from, slots: {}, keys: [], codex: { prev: null, model: null } });

/** Adds one entry to a file's merged rows. */
function slotIn(state, entry) {
  if (typeof entry.at !== "number" || !Number.isFinite(entry.at)) return;
  const total = FIELDS.reduce((n, f) => n + entry.tokens[f], 0);
  if (!total && !entry.usd) return;
  const at = Math.floor(entry.at / SLOT_MS) * SLOT_MS;
  const priced = typeof entry.usd === "number";
  const id = `${at}|${entry.model ?? ""}|${priced ? 1 : 0}`;
  let s = state.slots[id];
  if (!s) state.slots[id] = s = { at, model: entry.model ?? null, usd: priced ? 0 : null, t: [0, 0, 0, 0, 0] };
  if (priced) s.usd += entry.usd;
  FIELDS.forEach((f, i) => (s.t[i] += entry.tokens[f]));
}

/** One line of a file into its rows: the tool's own reading of usage records. */
function usageLine(tool, state, keys, bytes) {
  if (!WANT[tool](bytes)) return;
  const o = parse(bytes);
  if (!isObj(o)) return;
  if (tool === "omp") {
    const e = ompUsage(o);
    if (e) slotIn(state, e);
  } else if (tool === "claude") {
    const e = claudeUsage(o);
    if (!e) return;
    if (e.key) {
      if (keys.has(e.key)) return;
      keys.add(e.key);
    }
    slotIn(state, e);
  } else {
    if (o.type === "turn_context" && typeof o.payload?.model === "string") state.codex.model = o.payload.model;
    const total = codexTotal(o);
    if (!total) return;
    const tokens = codexDelta(state.codex.prev, total);
    state.codex.prev = total;
    const at = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
    slotIn(state, { tool: "codex", model: state.codex.model, at: Number.isFinite(at) ? at : null, tokens, usd: null, key: null });
  }
}

async function usage(input) {
  const now = typeof input.now === "number" && Number.isFinite(input.now) ? input.now : Date.now();
  const rates = isObj(input.rates) ? input.rates : RATES;
  const cacheFile = typeof input.cache === "string" && input.cache ? expand(input.cache) : path.join(CACHE_DIR, "usage-cache.json");
  const roots = rootsOf(input);
  const from = weekStart(now);
  const cached = readJson(cacheFile);
  const old = cached?.version === USAGE_VERSION && isObj(cached.files) ? cached.files : {};
  const files = {};
  const skipped = { files: 0, zst: 0, unreadable: 0 };
  const entries = [];
  for (const tool of TOOL_NAMES) {
    const root = roots[tool];
    if (!root) continue;
    for (const file of listFiles(root, { zst: tool === "codex" })) {
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        skipped.unreadable += 1;
        continue;
      }
      // Lines are appended in time order: a file last written before Monday holds nothing of this week.
      if (st.mtimeMs < from) {
        skipped.files += 1;
        continue;
      }
      const zst = file.endsWith(".zst");
      let state = old[file];
      const stale = !state || state.ino !== st.ino || st.size < state.size || state.from > from || (zst && (st.size !== state.size || st.mtimeMs !== state.mtime));
      if (stale) state = freshUsage(st, from);
      try {
        if (st.size !== state.size || st.mtimeMs !== state.mtime || stale) {
          const keys = new Set(state.keys);
          if (zst) {
            const r = await zstdLines(file, (line) => usageLine(tool, state, keys, line));
            if (!r.ok) {
              if (r.missing) skipped.zst += 1;
              else skipped.unreadable += 1;
              continue;
            }
          } else state.offset = readLines(file, state.offset, st.size, (line) => usageLine(tool, state, keys, line));
          state.keys = tool === "claude" ? [...keys] : [];
          state.size = st.size;
          state.mtime = st.mtimeMs;
        }
      } catch {
        skipped.unreadable += 1;
        continue;
      }
      // Rows before Monday are no longer asked about; a later run for an earlier week reads the file again.
      for (const [id, s] of Object.entries(state.slots)) if (s.at < from) delete state.slots[id];
      state.from = Math.max(state.from, from);
      files[file] = state;
      for (const s of Object.values(state.slots)) {
        const tokens = Object.fromEntries(FIELDS.map((f, i) => [f, s.t[i]]));
        entries.push(price({ tool, model: s.model, at: s.at, tokens, usd: s.usd, key: null }, rates));
      }
    }
  }
  writeJson(cacheFile, { version: USAGE_VERSION, files });
  return { version: 1, at: now, ...summarize(entries, now), skipped };
}

// ---------------------------------------------------------------------------------------------------------------------
// Past sessions (`sessions`), for the palette's search and resume. A row per top-level session: OMP's session files
// (subagents live in folders beside them), Claude Code's project files (not `agent-*`), Codex rollouts that no agent
// spawned. A row is read from the file's head (header, title, first prompt) and tail (last record, model), and kept
// in the index until the file's size or mtime changes. A `.zst` rollout is read from its head only: its mtime, set
// when Codex wrote its last record, is its `last`.

const SESSIONS_VERSION = 1;
const HEAD_BYTES = 2 << 20;
const TAIL_BYTES = 256 << 10;
const TITLE_CHARS = 200;
const UUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl(?:\.zst)?$/i;

/** A title from a prompt: its first non-empty line, without heading marks or hc's wrapper. */
function titleOf(value) {
  for (const raw of String(value ?? "").replace(/<\/?hc\b[^>]*>/g, "").split("\n")) {
    const line = raw.replace(/^#+\s*/, "").trim();
    if (line) return clipTo(line, TITLE_CHARS);
  }
  return "";
}

const timeOf = (v) => {
  const at = typeof v === "string" ? Date.parse(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(at) ? at : null;
};

/** The model id without a provider prefix ("anthropic/claude-opus-5-5" → "claude-opus-5-5"). */
const bareModel = (m) => (typeof m === "string" && m && m !== "<synthetic>" ? m.split("/").pop() : null);

/** A prompt's text: Codex wraps its own context in tags and AGENTS.md; those are not what the person asked. */
function promptText(content) {
  const parts = Array.isArray(content) ? content.map((c) => (typeof c?.text === "string" ? c.text : "")) : [typeof content === "string" ? content : ""];
  for (const p of parts) {
    const t = p.trim();
    if (t && !t.startsWith("<") && !t.startsWith("# AGENTS.md")) return t;
  }
  return "";
}

/** The newest timestamp and model in a file's tail. */
function tailFacts(file, size, modelOf) {
  let last = null;
  let model = null;
  const lines = tailLines(file, size, TAIL_BYTES);
  for (let i = lines.length - 1; i >= 0 && (last === null || model === null); i--) {
    const o = parse(lines[i]);
    if (!isObj(o)) continue;
    last ??= timeOf(o.timestamp);
    model ??= modelOf(o);
  }
  return { last, model };
}

const ompModel = (o) => (o.type === "message" && o.message?.role === "assistant" ? bareModel(o.message.model) : o.type === "model_change" ? bareModel(o.model) : null);
const claudeModel = (o) => (o.type === "assistant" ? bareModel(o.message?.model) : null);
const codexModel = (o) => (o.type === "turn_context" ? bareModel(o.payload?.model) : null);

function ompRow(file, st) {
  let header = null;
  let title = null;
  let prompt = null;
  let model = null;
  readLines(file, 0, Math.min(st.size, HEAD_BYTES), (line) => {
    const o = parse(line);
    if (!isObj(o)) return false;
    if (o.type === "title" && typeof o.title === "string") title = o.title;
    else if (o.type === "session") header = o;
    else if (o.type === "model_change") model ??= bareModel(o.model);
    else if (o.type === "message" && o.message?.role === "user") prompt ??= titleOf(text(o.message.content));
    return Boolean(header && model && (title || prompt));
  });
  const name = header ? titleOf(title ?? header.title) || prompt : null;
  // A session nobody wrote in (opened and closed) has nothing to come back to.
  if (!header || !name) return null;
  const tail = tailFacts(file, st.size, ompModel);
  return {
    tool: "omp", id: typeof header.id === "string" ? header.id : path.basename(file, ".jsonl"), path: file,
    cwd: typeof header.cwd === "string" ? header.cwd : null,
    title: name, first: timeOf(header.timestamp), last: tail.last ?? Math.floor(st.mtimeMs), model: tail.model ?? model,
  };
}

function claudeRow(file, st) {
  let cwd = null;
  let first = null;
  let prompt = null;
  let title = null;
  let model = null;
  readLines(file, 0, Math.min(st.size, HEAD_BYTES), (line) => {
    const o = parse(line);
    if (!isObj(o)) return false;
    first ??= timeOf(o.timestamp);
    if (typeof o.cwd === "string") cwd ??= o.cwd;
    if (o.type === "ai-title" && typeof o.aiTitle === "string") title = o.aiTitle;
    if (o.type === "assistant") model ??= bareModel(o.message?.model);
    if (o.type === "user" && !o.isMeta && o.message?.role === "user") prompt ??= titleOf(promptText(o.message.content)) || null;
    return Boolean(cwd && first && prompt && model);
  });
  let tailTitle = null;
  const lines = tailLines(file, st.size, TAIL_BYTES);
  for (let i = lines.length - 1; i >= 0 && !tailTitle; i--) {
    const o = has(lines[i], '"ai-title"') ? parse(lines[i]) : null;
    if (o?.type === "ai-title" && typeof o.aiTitle === "string") tailTitle = o.aiTitle;
  }
  const name = titleOf(tailTitle ?? title) || prompt;
  if (!name) return null;
  const tail = tailFacts(file, st.size, claudeModel);
  return {
    tool: "claude", id: path.basename(file, ".jsonl"), path: file, cwd,
    title: name, first, last: tail.last ?? Math.floor(st.mtimeMs), model: tail.model ?? model,
  };
}

/** Folds a Codex rollout's head into `h`; true once nothing more is needed (or it is a spawned agent's). */
function codexHead(h, bytes) {
  const o = parse(bytes);
  if (!isObj(o)) return false;
  const p = o.payload;
  if (o.type === "session_meta" && isObj(p)) {
    h.meta = p;
    if (isObj(p.source) && p.source.subagent !== undefined) h.spawned = true;
    if (p.thread_source === "subagent") h.spawned = true;
  } else if (o.type === "turn_context") h.model ??= bareModel(p?.model);
  else if (o.type === "event_msg" && p?.type === "user_message" && typeof p.message === "string") h.prompt ??= titleOf(p.message) || null;
  else if (o.type === "response_item" && p?.type === "message" && p.role === "user") h.prompt ??= titleOf(promptText(p.content)) || null;
  h.read += bytes.length + 1;
  return Boolean(h.spawned || (h.meta && h.model && h.prompt) || h.read > HEAD_BYTES);
}

async function codexRow(file, st, skipped) {
  const h = { meta: null, model: null, prompt: null, spawned: false, read: 0 };
  let tail = { last: null, model: null };
  if (file.endsWith(".zst")) {
    const r = await zstdLines(file, (line) => codexHead(h, line));
    if (!r.ok) {
      if (r.missing) skipped.zst += 1;
      else skipped.unreadable += 1;
      return undefined;
    }
  } else {
    readLines(file, 0, Math.min(st.size, HEAD_BYTES), (line) => codexHead(h, line));
    tail = tailFacts(file, st.size, codexModel);
  }
  if (h.spawned || !h.meta || !h.prompt) return null;
  const id = UUID.exec(file)?.[1] ?? (typeof h.meta.id === "string" ? h.meta.id : path.basename(file));
  return {
    tool: "codex", id, path: file, cwd: typeof h.meta.cwd === "string" ? h.meta.cwd : null,
    title: h.prompt, first: timeOf(h.meta.timestamp), last: tail.last ?? Math.floor(st.mtimeMs), model: tail.model ?? h.model,
  };
}

async function sessions(input) {
  const query = typeof input.query === "string" ? input.query.trim().toLowerCase() : "";
  const limit = Number.isInteger(input.limit) && input.limit >= 0 ? input.limit : 200;
  const cacheFile = typeof input.cache === "string" && input.cache ? expand(input.cache) : path.join(CACHE_DIR, "sessions-index.json");
  const roots = rootsOf(input);
  const cached = readJson(cacheFile);
  const old = cached?.version === SESSIONS_VERSION && isObj(cached.files) ? cached.files : {};
  const files = {};
  const skipped = { files: 0, zst: 0, unreadable: 0 };
  const jobs = [];
  for (const tool of TOOL_NAMES) {
    const root = roots[tool];
    if (!root) continue;
    // OMP and Claude Code keep a session in <root>/<project>/<file>.jsonl; their subagents sit deeper.
    const list = tool === "codex" ? listFiles(root, { zst: true }).filter((f) => path.basename(f).startsWith("rollout-")) : listFiles(root, { depth: 1 });
    for (const file of list) if (!(tool === "claude" && path.basename(file).startsWith("agent-"))) jobs.push({ tool, file });
  }
  await pool(jobs, 8, async ({ tool, file }) => {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      skipped.unreadable += 1;
      return;
    }
    const prev = old[file];
    if (prev && prev.size === st.size && prev.mtime === st.mtimeMs) {
      files[file] = prev;
      if (!prev.row) skipped.files += 1;
      return;
    }
    let row;
    try {
      row = tool === "omp" ? ompRow(file, st) : tool === "claude" ? claudeRow(file, st) : await codexRow(file, st, skipped);
    } catch {
      skipped.unreadable += 1;
      return;
    }
    // undefined: not readable now (zstd missing), so tried again next time; null: not a session to list.
    if (row === undefined) return;
    if (!row) skipped.files += 1;
    files[file] = { size: st.size, mtime: st.mtimeMs, row };
  });
  writeJson(cacheFile, { version: SESSIONS_VERSION, files });
  const rows = Object.values(files)
    .map((f) => f.row)
    .filter((r) => r && (!query || r.title.toLowerCase().includes(query) || (r.cwd ?? "").toLowerCase().includes(query)))
    .sort((a, b) => (b.last ?? 0) - (a.last ?? 0) || a.path.localeCompare(b.path));
  return { version: 1, at: Date.now(), total: rows.length, sessions: rows.slice(0, limit), skipped };
}

// ---------------------------------------------------------------------------------------------------------------------

const [cmd, ...rest] = process.argv.slice(2);
const OLD = new Set(["tree", "detail", "transcript", "run", "call"]);
if (cmd === "usage" || cmd === "sessions") {
  let input = {};
  let bad = false;
  if (rest[0] !== undefined) {
    try {
      input = JSON.parse(rest[0]);
    } catch {
      bad = true;
    }
    if (!isObj(input)) bad = true;
  }
  if (bad) {
    process.stderr.write(`scan.mjs ${cmd}: the argument must be a JSON object\n`);
    process.exitCode = 2;
  } else {
    try {
      const out = cmd === "usage" ? await usage(input) : await sessions(input);
      process.stdout.write(`${JSON.stringify(out)}\n`);
    } catch (e) {
      process.stdout.write(`${JSON.stringify({ error: String(e?.message ?? e) })}\n`);
      process.exitCode = 1;
    }
  }
} else if (OLD.has(cmd)) {
  try {
    let out;
    if (cmd === "tree") out = tree(JSON.parse(rest[0] ?? "{}"));
    else if (cmd === "detail") out = detail(rest[0], rest[1]);
    else if (cmd === "transcript") out = transcript(rest[0], Number(rest[1] ?? 0) || 0);
    else if (cmd === "run") out = run(JSON.parse(rest[0] ?? "{}"));
    else out = call(JSON.parse(rest[0] ?? "{}"));
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch (e) {
    process.stdout.write(`${JSON.stringify({ error: String(e?.message ?? e) })}\n`);
    process.exitCode = 1;
  }
} else {
  process.stderr.write(`scan.mjs: unknown subcommand ${cmd ?? "(none)"}; one of tree, detail, transcript, run, call, usage, sessions\n`);
  process.exitCode = 2;
}
