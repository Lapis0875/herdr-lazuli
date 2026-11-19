// The GitHub service (ARCHITECTURE §4.1): one `gh api graphql` query for the inbox, my PRs, my merges and CI, polled
// every 120 s while the window is active and every 600 s otherwise (at once when Inbox or Home opens with data older
// than 30 s), backing off to 15 min on failures and pausing while the rate limit is low. The answer goes to the store
// as STORE.gh (snapshot data/lazuli/snap/gh.json); the events between two answers go to `onEvents` listeners (routine
// triggers, notifications). Details (review threads, PR files, CI log, failed job) are fetched on demand and kept
// 180 s; actions merge a PR and rerun failed jobs. Started by the `status` copy: start(cx) / stop().

import { exec, checking, window } from "herdr";
import * as store from "./store.js";
import { STORE } from "./state.js";
import { buildQuery, mergedSince, mapGithub, mapRuns, diffEvents, failedTests, tailLines, ghError } from "../core/gh-map.js";

/** Poll cadence and limits (ms unless named otherwise). */
export const INACTIVE_MS = 600000;
export const STALE_MS = 30000;
export const MAX_BACKOFF_MS = 900000;
export const DETAIL_MS = 180000;
export const GH_TIMEOUT_MS = 25000;
const QUERY_TIMEOUT_MS = 60000;
const ACTION_TIMEOUT_MS = 40000;
const MIN_POLL_MS = 30000;
const RATE_FLOOR = 200;
const TICK_MS = 5000;
const KEEP_RECENT = 50;
const LOG_LINES = 200;
const STEP_ASKS = 5;
const STEP_RETRY_MS = 600000;

const log = (msg) => console.log(`[lazuli/gh] ${msg}`);
const errText = (e) => e?.message ?? String(e);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);

function parseJson(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Runs gh; never rejects: `{code, stdout, stderr}`, with code -1 when it could not start. */
async function gh(args, timeout = GH_TIMEOUT_MS) {
  try {
    return await exec("gh", args, { timeout });
  } catch (e) {
    return { code: -1, stdout: "", stderr: errText(e) };
  }
}

/** The error of a gh result, as ghError reads it; "other" for a failure gh did not explain. */
const failure = (r, fallback = "gh failed") => ghError(r) ?? { kind: "other", message: fallback };

// The service's state. Module scope: one per source version, shared by every copy (F3).

const svc = {
  running: false,
  timer: null,
  inflight: null,
  /** When the last poll started (a warm snapshot counts as one, so the cadence carries on). */
  lastTry: 0,
  failures: 0,
  /** No poll before this (rate limit). */
  pausedUntil: 0,
  /** "auth": no poll until a view opens again; "relay": never in this run (a device reads the snapshot). */
  blocked: null,
  /** A view asked for fresh data without a cx; the next tick polls. */
  wanted: false,
};

const listeners = new Set();

/** The empty value, before any answer. */
function emptyValue() {
  const read = { review: false, mine: false, merged: false };
  return { version: 1, at: null, ...strip(mapGithub(null)), heads: {}, headRepos: {}, reviewHeads: {}, reviewHeadRepos: {}, runs: [], read, missing: [], events: [], eventsAt: null, recent: [], error: null };
}

function strip(github) {
  const { mineNodes: _nodes, ...rows } = github;
  return rows;
}

/** The STORE.gh value: `{version, at, direct, team, botRepos, mine, merged, rateLimit, heads, headRepos, reviewHeads,
 *  reviewHeadRepos, runs, read, missing, events, eventsAt, recent, error}`, or null before the snapshot or an answer.
 *  `at` is the last good answer's time; `read` says which sections (review, mine, merged) hold rows GitHub gave,
 *  `missing` which ones the last answer lacked (kept from the answer before). */
export function data() {
  const v = store.get(STORE.gh);
  return isObj(v) ? v : null;
}

/** Warm start from the snapshot (views may call it in init). */
export function load() {
  return store.load(STORE.gh);
}

/** What the service is doing, for a view's status line. Not reactive: read it when the store re-renders. */
export function state() {
  return { running: svc.running, polling: Boolean(svc.inflight), wanted: svc.wanted, blocked: svc.blocked, pausedUntil: svc.pausedUntil, failures: svc.failures, nextAt: nextAt() };
}

/** Calls `fn(events)` after each answer that brought events (GhEvent[] with `at`). Returns a function that stops it. */
export function onEvents(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(events) {
  for (const fn of [...listeners]) {
    try {
      fn(events);
    } catch (e) {
      log(`event listener failed: ${errText(e)}`);
    }
  }
}

function interval() {
  const poll = Math.max(MIN_POLL_MS, store.settings().gh.pollSec * 1000);
  const base = window()?.active === false ? Math.max(INACTIVE_MS, poll) : poll;
  return svc.failures ? Math.min(base * 2 ** svc.failures, MAX_BACKOFF_MS) : base;
}

function nextAt() {
  if (svc.blocked) return null;
  return Math.max(svc.lastTry + interval(), svc.pausedUntil);
}

function due(now) {
  if (svc.blocked || svc.inflight || now < svc.pausedUntil) return false;
  return svc.wanted || now - svc.lastTry >= interval();
}

/** Starts polling (the `status` copy's init). Safe to call again; does nothing under `herdr-app check`. */
export function start(cx) {
  if (svc.running || checking()) return;
  svc.running = true;
  cx.spawn(async () => {
    const warm = await load();
    // A recent snapshot carries the cadence on rather than asking again after every reload.
    if (isObj(warm) && typeof warm.at === "number") svc.lastTry = Math.max(svc.lastTry, Math.min(warm.at, Date.now()));
  });
  svc.timer = cx.timer.every(TICK_MS, (cx) => {
    if (svc.running && due(Date.now())) cx.spawn(async () => poll());
  });
}

/** Stops polling (the `status` copy's close). A poll under way still lands. */
export function stop() {
  svc.running = false;
  svc.timer?.cancel();
  svc.timer = null;
}

/** Inbox or Home opened: polls at once when the data is older than 30 s, and lets a "not signed in" state try again. */
export function opened(cx) {
  if (svc.blocked === "auth") svc.blocked = null;
  const at = data()?.at;
  if (typeof at !== "number" || Date.now() - at > STALE_MS) refresh(cx);
}

/** Polls now (unless refused by herdr-relay or paused by the rate limit). With a cx the poll starts at once and
 *  outlives the view that asked; without one the next tick (≤5 s) polls. */
export function refresh(cx) {
  if (checking() || svc.blocked === "relay" || Date.now() < svc.pausedUntil) return;
  if (svc.blocked === "auth") svc.blocked = null;
  if (cx) cx.spawn(async () => poll(), { owner: null });
  else svc.wanted = true;
}

/** One poll at a time; a second caller waits for the one under way. */
function poll() {
  if (!svc.inflight) {
    svc.inflight = pollOnce()
      .catch((e) => log(`poll failed: ${errText(e)}`))
      .finally(() => {
        svc.inflight = null;
      });
  }
  return svc.inflight;
}

// A poll's answer can lack a search (GitHub returns `null` for it beside an error): each section of the value keeps
// what it last read then, and yields events only between two answers that both read it, so a search that failed
// once never makes its rows look new on the next good poll.

/** The searches each section needs: review requests (which of them ask me directly: `direct`), my PRs, my merges. */
const SECTIONS = { review: ["review", "direct"], mine: ["mine"], merged: ["merged"] };
/** The value's fields each section fills. */
const SECTION_FIELDS = {
  review: ["direct", "team", "botRepos", "reviewHeads", "reviewHeadRepos"],
  mine: ["mine", "runs", "heads", "headRepos"],
  merged: ["merged"],
};

const searched = (d, key) => isObj(d?.[key]) && Array.isArray(d[key].nodes);

/** Which sections a stored value holds as read from GitHub (a value from before `read` existed: all of them). */
function heldBy(value) {
  if (!value) return { review: false, mine: false, merged: false };
  const r = isObj(value.read) ? value.read : null;
  return Object.fromEntries(Object.keys(SECTIONS).map((s) => [s, r ? r[s] === true : true]));
}

async function pollOnce() {
  svc.wanted = false;
  svc.lastTry = Date.now();
  const query = buildQuery({ orgs: store.settings().gh.org, mergedSince: mergedSince(svc.lastTry) });
  const r = await gh(["api", "graphql", "-f", `query=${query}`], QUERY_TIMEOUT_MS);
  const answer = parseJson(r.stdout);
  const d = answer?.data;
  const read = Object.fromEntries(Object.entries(SECTIONS).map(([s, keys]) => [s, keys.every((k) => searched(d, k))]));
  // GitHub's data counts even beside errors (a repo behind SAML, a search that failed); gh then exits 1.
  if (!Object.values(read).some(Boolean)) return fail(failure(r, list(answer?.errors)[0]?.message ?? "no data"));
  const prev = data();
  const github = mapGithub(read.mine ? await completeMine(d) : d);
  const runs = read.mine ? await fillSteps(mapRuns(github.mineNodes, prev?.runs)) : [];
  const reviewNodes = list(d?.review?.nodes);
  const next = {
    ...strip(github),
    heads: headsOf(github.mineNodes),
    headRepos: headReposOf(github.mineNodes),
    reviewHeads: headsOf(reviewNodes),
    reviewHeadRepos: headReposOf(reviewNodes),
    runs,
  };
  const was = heldBy(prev);
  const held = {};
  const base = { ...prev };
  for (const s of Object.keys(SECTIONS)) {
    if (!read[s]) for (const f of SECTION_FIELDS[s]) next[f] = prev?.[f] ?? next[f];
    held[s] = read[s] || was[s];
    // Events only where both answers read the section.
    if (!(read[s] && was[s])) for (const f of SECTION_FIELDS[s]) base[f] = next[f];
  }
  const now = Date.now();
  // The last good answer is the base, also across a restart (the snapshot): nothing that happened meanwhile is lost.
  const events = typeof prev?.at === "number" ? diffEvents(base, next).map((e) => ({ ...e, at: now })) : [];
  const missing = Object.keys(SECTIONS).filter((s) => !read[s]);
  if (missing.length) log(`partial answer, kept the last ${missing.join(", ")}: ${list(answer?.errors)[0]?.message ?? "no data"}`);
  svc.failures = 0;
  const remaining = next.rateLimit?.remaining;
  const reset = Date.parse(next.rateLimit?.resetAt ?? "");
  svc.pausedUntil = typeof remaining === "number" && remaining < RATE_FLOOR && reset > now ? reset : 0;
  store.set(STORE.gh, {
    version: 1,
    at: now,
    ...next,
    read: held,
    missing,
    events,
    eventsAt: events.length ? now : prev?.eventsAt ?? null,
    recent: [...events, ...list(prev?.recent)].slice(0, KEEP_RECENT),
    error: null,
  });
  if (events.length) emit(events);
}

// Lists past their first page on a PR of mine, paged in before mapping: checks (100 a page, at most CHECK_PAGES
// pages), so failedChecks, the failing job and every failed workflow (rerun) are known; review threads (at most
// THREAD_PAGES), so an open thread past the first 50 counts. Checks are read off the commit by its oid, so a push
// meanwhile cannot mix two commits' checks; threads by the PR's node id. A page that fails leaves the list partial:
// mapRuns then goes by the rollup state, and the PR row says `threadsPartial`. The fields are those of buildQuery's
// `mine`.
const CHECK_PAGES = 3;
const THREAD_PAGES = 5;
const CONTEXTS =
  "query($owner: String!, $name: String!, $oid: GitObjectID!, $after: String!) { repository(owner: $owner, name: $name) { object(oid: $oid) { ... on Commit { statusCheckRollup { contexts(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ... on CheckRun { databaseId name status conclusion detailsUrl checkSuite { workflowRun { databaseId } } } ... on StatusContext { context state targetUrl } } } } } } } }";
const THREAD_STATES =
  "query($id: ID!, $after: String!) { node(id: $id) { ... on PullRequest { reviewThreads(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { isResolved } } } } }";

const contextsOf = (node) => node?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
const more = (conn) => conn?.pageInfo?.hasNextPage === true;

/** A connection paged on from its `pageInfo`, at most `max` more pages: `fetchPage(after)` resolves the next
 *  `{nodes, pageInfo}`, or null when it could not be read (paging stops there). */
async function pageOn(conn, max, fetchPage) {
  let nodes = list(conn?.nodes);
  let pageInfo = conn?.pageInfo;
  let failed = false;
  for (let i = 0; i < max && pageInfo?.hasNextPage === true && typeof pageInfo.endCursor === "string"; i++) {
    const page = await fetchPage(pageInfo.endCursor);
    if (!Array.isArray(page?.nodes) || !isObj(page.pageInfo)) {
      failed = true;
      break;
    }
    nodes = [...nodes, ...page.nodes];
    pageInfo = page.pageInfo;
  }
  return { nodes, pageInfo, failed };
}

/** A page from a gh graphql answer at `path`, or null (logged) when gh failed. */
async function graphPage(args, path, what) {
  const r = await gh(["api", "graphql", ...args]);
  const page = path(parseJson(r.stdout)?.data);
  if (r.code === 0 && Array.isArray(page?.nodes)) return page;
  log(`${what} not read: ${failure(r, "no data").message}`);
  return null;
}

async function moreChecks(node) {
  const commit = node?.commits?.nodes?.[0]?.commit;
  const conn = contextsOf(node);
  const slug = node?.repository?.nameWithOwner;
  if (!more(conn) || typeof commit?.oid !== "string" || !SLUG.test(slug ?? "")) return node;
  const [owner, name] = slug.split("/");
  const got = await pageOn(conn, CHECK_PAGES, (after) =>
    graphPage(
      ["-f", `query=${CONTEXTS}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-f", `oid=${commit.oid}`, "-f", `after=${after}`],
      (d) => d?.repository?.object?.statusCheckRollup?.contexts,
      `checks of ${slug}@${commit.oid.slice(0, 7)}`,
    ),
  );
  if (got.nodes.length === list(conn.nodes).length) return node;
  const [head, ...rest] = node.commits.nodes;
  const rollup = { ...commit.statusCheckRollup, contexts: { ...conn, nodes: got.nodes, pageInfo: got.pageInfo } };
  return { ...node, commits: { ...node.commits, nodes: [{ ...head, commit: { ...commit, statusCheckRollup: rollup } }, ...rest] } };
}

async function moreThreads(node) {
  const conn = node?.reviewThreads;
  if (!more(conn) || typeof node?.id !== "string") return node;
  const got = await pageOn(conn, THREAD_PAGES, (after) =>
    graphPage(["-f", `query=${THREAD_STATES}`, "-f", `id=${node.id}`, "-f", `after=${after}`], (d) => d?.node?.reviewThreads, `threads of ${node.url}`),
  );
  if (got.nodes.length === list(conn.nodes).length) return node;
  return { ...node, reviewThreads: { ...conn, nodes: got.nodes, pageInfo: got.pageInfo } };
}

/** The query's data with every partial check and thread list of `mine` paged in (as far as the bounds reach). */
async function completeMine(d) {
  const mine = d?.mine?.nodes;
  if (!Array.isArray(mine) || !mine.some((n) => more(contextsOf(n)) || more(n?.reviewThreads))) return d;
  const nodes = [];
  for (const n of mine) nodes.push(await moreThreads(await moreChecks(n)));
  return { ...d, mine: { ...d.mine, nodes } };
}

function fail(err) {
  const now = Date.now();
  if (err.kind === "auth" || err.kind === "relay") svc.blocked = err.kind;
  else if (err.kind === "rate") {
    svc.failures += 1;
    svc.pausedUntil = now + MAX_BACKOFF_MS;
  } else svc.failures += 1;
  log(`${err.kind}: ${err.message}`);
  // A device keeps the snapshot it was given (writes are refused there anyway).
  store.set(STORE.gh, { ...(data() ?? emptyValue()), error: { ...err, at: now } }, { snapshot: err.kind !== "relay" });
}

// Failing steps of Actions jobs: asked once per job (again after 10 min when GitHub did not say).

const steps = new Map();

async function failedStep(slug, jobId) {
  const r = await gh(["api", `repos/${slug}/actions/jobs/${jobId}`]);
  if (r.code !== 0) return null;
  const step = list(parseJson(r.stdout)?.steps).find((s) => s?.conclusion === "failure");
  return typeof step?.name === "string" ? step.name : null;
}

async function fillSteps(runs) {
  const now = Date.now();
  if (steps.size > 500) steps.clear();
  let asked = 0;
  const out = [];
  for (const run of runs) {
    const f = run.failed;
    if (!f || f.step !== undefined || !f.jobId || run.isRunning) {
      out.push(run);
      continue;
    }
    const key = `${run.slug}/${f.jobId}`;
    let known = steps.get(key);
    if ((!known || (known.step === null && now - known.at >= STEP_RETRY_MS)) && asked < STEP_ASKS) {
      asked += 1;
      known = { step: await failedStep(run.slug, f.jobId), at: now };
      steps.set(key, known);
    }
    out.push(known?.step ? { ...run, failed: { ...f, step: known.step } } : run);
  }
  return out;
}

// Details on demand, kept DETAIL_MS per (kind, args); an error is never kept.

const THREADS =
  "query($owner: String!, $name: String!, $number: Int!, $after: String) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { isResolved isOutdated path line originalLine comments(first: 50) { nodes { author { login } body } } } } } } }";

const cache = new Map();
const pending = new Map();
const keyOf = (kind, args) => `${kind} ${JSON.stringify(args ?? {})}`;
const SLUG = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const badArgs = (what) => ({ error: { kind: "bad-args", message: what } });

/** A PR's `owner/name`: its `slug`, else read from its URL. */
export function slugOf(pr) {
  if (typeof pr?.slug === "string" && SLUG.test(pr.slug)) return pr.slug;
  const m = /github\.com\/([^/\s]+\/[^/\s]+)\/pull\/\d+/.exec(typeof pr?.url === "string" ? pr.url : "");
  return m && SLUG.test(m[1]) ? m[1] : null;
}

async function threads({ slug, number }) {
  if (!SLUG.test(slug ?? "") || !Number.isInteger(number)) return badArgs("slug, number");
  const [owner, name] = slug.split("/");
  const args = (after) => ["-f", `query=${THREADS}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`, ...(after ? ["-f", `after=${after}`] : [])];
  const r = await gh(["api", "graphql", ...args(null)]);
  const answer = parseJson(r.stdout);
  const conn = answer?.data?.repository?.pullRequest?.reviewThreads;
  if (!Array.isArray(conn?.nodes)) return { error: failure(r, list(answer?.errors)[0]?.message ?? "no such PR") };
  const got = await pageOn(conn, THREAD_PAGES - 1, (after) => graphPage(args(after), (d) => d?.repository?.pullRequest?.reviewThreads, `threads of ${slug}#${number}`));
  const out = got.nodes
    .filter((t) => t?.isResolved !== true)
    .map((t) => {
      const comments = list(t?.comments?.nodes).map((c) => ({ author: c?.author?.login ?? null, body: c?.body ?? null }));
      return {
        path: t?.path ?? null,
        line: t?.line ?? t?.originalLine ?? null,
        author: comments[0]?.author ?? null,
        body: comments[0]?.body ?? null,
        outdated: t?.isOutdated ?? null,
        comments,
      };
    });
  // `partial`: more threads than THREAD_PAGES pages hold, or a page that could not be read.
  return { value: { threads: out, partial: more(got) } };
}

async function files({ slug, number }) {
  if (!SLUG.test(slug ?? "") || !Number.isInteger(number)) return badArgs("slug, number");
  const r = await gh(["pr", "view", String(number), "--repo", slug, "--json", "files"]);
  const answer = parseJson(r.stdout);
  if (r.code !== 0 || !isObj(answer)) return { error: failure(r) };
  return { value: { files: list(answer.files) } };
}

// CI details: a failed Actions job, else the failed runs of a workflow-run list or of a commit, else (the fallback)
// the branch's last failed run. Run ids come from a Run of STORE.gh: `failed.jobId` (the failing check's Actions job),
// `workflowId` (its failed workflow runs, "," joined) and `runId` (the head commit's oid, passed as `sha`).

const digits = (v) => (Number.isInteger(v) && v >= 0 ? String(v) : typeof v === "string" && /^\d+$/.test(v) ? v : null);
const SHA = /^[0-9a-f]{7,40}$/i;

/** CI detail arguments as cached: `{slug, branch, jobId, workflowId, sha}`, absent or malformed ids as null. */
function ciNorm(args) {
  const a = isObj(args) ? args : {};
  const workflows = String(a.workflowId ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => digits(id) !== null);
  return {
    slug: typeof a.slug === "string" ? a.slug : null,
    branch: typeof a.branch === "string" && a.branch !== "" ? a.branch : null,
    jobId: digits(a.jobId),
    workflowId: workflows.length ? workflows.join(",") : null,
    sha: typeof a.sha === "string" && SHA.test(a.sha) ? a.sha.toLowerCase() : null,
  };
}

/** The CI Run of STORE.gh for a PR of mine: the one carrying its URL (`pr`). Two PRs into one repo can share a branch
 *  name (from two forks), so slug and branch decide only for a Run without a URL (a snapshot from before), or a PR
 *  given without one, and only when exactly one Run matches. Null otherwise. */
export function runOf(pr) {
  const runs = list(data()?.runs);
  const url = typeof pr?.url === "string" && pr.url !== "" ? pr.url : null;
  const own = url ? runs.find((r) => r?.pr === url) : null;
  if (own) return own;
  const slug = slugOf(pr);
  const same = runs.filter((r) => r?.slug === slug && r?.branch === pr?.branch && (!url || typeof r?.pr !== "string"));
  return same.length === 1 ? same[0] : null;
}

/** The arguments of `detail("log" | "failed")` for a Run, or for a PR (through runOf): the failing check's job when
 *  it is an Actions job, else the head commit's failed runs (the Run's commit, else the PR's head from headOf, review
 *  requests included). With neither, `{slug, branch}`, which the details answer as "unavailable": a branch name can be
 *  another fork's or another commit's. Null without a slug. */
export function ciArgs(x) {
  const run = typeof x?.runId === "string" ? x : runOf(x);
  const slug = run?.slug ?? slugOf(x);
  const branch = run?.branch ?? (typeof x?.branch === "string" ? x.branch : null);
  if (!slug) return null;
  if (!run) {
    const head = headOf(x);
    return head ? { slug, branch, sha: head } : { slug, branch };
  }
  if (digits(run.failed?.jobId)) return { slug, branch, jobId: run.failed.jobId };
  if (run.workflowId) return { slug, branch, workflowId: run.workflowId };
  return { slug, branch, sha: run.runId };
}

/** The head commit GitHub reported for a PR (mine, or one asking for my review) in the last answer, or null. */
export function headOf(pr) {
  const url = pr?.url;
  const head = data()?.heads?.[url] ?? data()?.reviewHeads?.[url];
  return typeof head === "string" ? head : null;
}

/** PR URL → a field of PR nodes: the head commit (`heads`, `reviewHeads`) and the repo the head branch lives in
 *  (`headRepos`, `reviewHeadRepos`: owner/name, which tells two forks' branches of one name apart). */
function byUrl(nodes, read) {
  const out = {};
  for (const n of list(nodes)) {
    const v = read(n);
    if (typeof n?.url === "string" && typeof v === "string") out[n.url] = v;
  }
  return out;
}

const headsOf = (nodes) => byUrl(nodes, (n) => n?.commits?.nodes?.[0]?.commit?.oid ?? n?.headRefOid);
const headReposOf = (nodes) => byUrl(nodes, (n) => n?.headRepository?.nameWithOwner);

/** The failed workflow runs' failed-step logs, joined in order. */
async function runLogs(slug, ids) {
  let text = "";
  for (const id of ids) {
    const view = await gh(["run", "view", id, "--repo", slug, "--log-failed"]);
    if (view.code !== 0) return { error: failure(view) };
    text += view.stdout.endsWith("\n") || !view.stdout ? view.stdout : `${view.stdout}\n`;
  }
  return { value: { runs: ids.map(Number), job: null, text } };
}

/** Failed run ids `gh run list` reports for a commit (newest first). */
async function failedRuns(slug, sha) {
  const r = await gh(["run", "list", "--repo", slug, "--commit", sha, "--status", "failure", "--limit", "20", "--json", "databaseId"]);
  const runs = parseJson(r.stdout);
  if (r.code !== 0 || !Array.isArray(runs)) return { error: failure(r) };
  return { value: runs.map((x) => digits(x?.databaseId)).filter((id) => id !== null) };
}

/** The whole failed-step log of a normalized CI argument set: `{source, runs, job, text}`. */
function failedLog(a) {
  return cached("raw-log", a, async () => {
    if (a.jobId) {
      const view = await gh(["run", "view", "--job", a.jobId, "--repo", a.slug, "--log-failed"]);
      if (view.code !== 0) return { error: failure(view) };
      return { value: { source: "job", runs: [], job: a.jobId, text: view.stdout } };
    }
    if (a.workflowId) {
      const got = await runLogs(a.slug, a.workflowId.split(","));
      return got.error ? got : { value: { source: "runs", ...got.value } };
    }
    const ids = await failedRuns(a.slug, a.sha);
    if (ids.error) return ids;
    const got = await runLogs(a.slug, ids.value);
    return got.error ? got : { value: { source: "commit", ...got.value } };
  });
}

/** Whether CI arguments name an exact job, run or commit; a branch alone does not. */
const exact = (a) => Boolean(a.jobId || a.workflowId || a.sha);
const badSlug = (a) => (SLUG.test(a.slug ?? "") ? null : badArgs("slug"));

async function ciLog(a) {
  const bad = badSlug(a);
  if (bad) return bad;
  if (!exact(a)) return { value: { source: "unavailable", runs: [], job: null, lines: [] } };
  const got = await failedLog(a);
  if (got.error) return got;
  const { source, runs, job, text } = got.value;
  return { value: { source, runs, job, lines: tailLines(text, LOG_LINES) } };
}

/** The failed job (the store's Run that names it, else the given job id), its failing step, and the test names its
 *  log shows. */
async function failedJob(a) {
  const bad = badSlug(a);
  if (bad) return bad;
  if (!exact(a)) return { value: { source: "unavailable", job: null, jobId: null, step: null, tests: [], logs: null } };
  const runs = list(data()?.runs).filter((r) => r?.slug === a.slug);
  const run =
    (a.jobId && runs.find((r) => r.failed?.jobId === a.jobId)) ||
    (a.workflowId && runs.find((r) => r.workflowId === a.workflowId)) ||
    (a.sha && runs.find((r) => String(r.runId).toLowerCase() === a.sha)) ||
    null;
  const f = run?.failed ?? null;
  const jobId = a.jobId ?? digits(f?.jobId);
  let step = f?.jobId === jobId ? f?.step ?? null : null;
  if (step === null && jobId && !run?.isRunning) {
    const key = `${a.slug}/${jobId}`;
    step = steps.get(key)?.step ?? (await failedStep(a.slug, jobId));
    steps.set(key, { step, at: Date.now() });
  }
  const got = await failedLog(a);
  if (got.error) return got;
  const named = f && f.jobId === (jobId ?? f.jobId);
  return { value: { source: got.value.source, job: named ? f.job : null, jobId, step, tests: failedTests(got.value.text), logs: named ? f.logs : null } };
}

/** At most this much of a PR's diff is kept (characters, cut at a line end). */
export const DIFF_CHARS = 200000;

/** The PR's head commit GitHub reports now, or `{error}`. */
async function headNow(slug, number) {
  const r = await gh(["pr", "view", String(number), "--repo", slug, "--json", "headRefOid"]);
  const head = parseJson(r.stdout)?.headRefOid;
  return r.code === 0 && typeof head === "string" ? { head } : { error: failure(r, "no head commit") };
}

/** A PR's facts and its diff, for a planner that cannot run gh itself (data from GitHub, untrusted). The facts and
 *  the diff are two calls, so the head is read again after the diff: one that moved meanwhile reads it all once
 *  more, and moving again answers `{error: {kind: "moved"}}` rather than a diff of another commit than `head`. */
async function prDiff({ slug, number }) {
  if (!SLUG.test(slug ?? "") || !Number.isInteger(number)) return badArgs("slug, number");
  for (let attempt = 0; attempt < 2; attempt++) {
    const view = await gh(["pr", "view", String(number), "--repo", slug, "--json", "title,body,headRefOid,baseRefName,headRefName,files"]);
    const pr = parseJson(view.stdout);
    if (view.code !== 0 || !isObj(pr) || typeof pr.headRefOid !== "string") return { error: failure(view, "no head commit") };
    const d = await gh(["pr", "diff", String(number), "--repo", slug, "--color", "never"], ACTION_TIMEOUT_MS);
    if (d.code !== 0) return { error: failure(d) };
    const after = await headNow(slug, number);
    if (after.error) return after;
    if (after.head !== pr.headRefOid) continue;
    const whole = d.stdout;
    const truncated = whole.length > DIFF_CHARS;
    const end = truncated ? whole.lastIndexOf("\n", DIFF_CHARS - 1) + 1 : whole.length;
    return {
      value: {
        title: typeof pr.title === "string" ? pr.title : "",
        body: typeof pr.body === "string" ? pr.body : "",
        head: pr.headRefOid,
        base: typeof pr.baseRefName === "string" ? pr.baseRefName : null,
        branch: typeof pr.headRefName === "string" ? pr.headRefName : null,
        files: list(pr.files).map((f) => ({ path: f?.path ?? null, additions: f?.additions ?? 0, deletions: f?.deletions ?? 0, changeType: f?.changeType ?? null })),
        diff: whole.slice(0, end > 0 ? end : DIFF_CHARS),
        size: whole.length,
        truncated,
      },
    };
  }
  return { error: { kind: "moved", message: `${slug}#${number} moved while it was read` } };
}

const KINDS = { threads, files, log: ciLog, failed: failedJob, diff: prDiff };

/** The kinds `detail` knows: threads and files take {slug, number}; diff takes {slug, number, head?}; log and failed
 *  take {slug, branch?, jobId?, workflowId?, sha?} (ciArgs builds them). */
export const DETAIL_KINDS = Object.freeze(Object.keys(KINDS));

// A diff is kept per head commit. Without a head given, detail() first asks GitHub for the PR's head now, so a push
// the poll has not seen yet still gets its own diff; `diffHeads` remembers that answer for peek(), which cannot ask.
const diffHeads = new Map();
const prRef = (slug, number) => ({ url: `https://github.com/${slug}/pull/${number}` });

/** The arguments as cached (and as the fetch gets them), whatever the caller added. */
function argsFor(kind, args) {
  if (kind === "log" || kind === "failed") return ciNorm(args);
  const slug = args?.slug ?? null;
  const number = args?.number ?? null;
  if (kind !== "diff") return { slug, number };
  const given = typeof args?.head === "string" && SHA.test(args.head) ? args.head.toLowerCase() : null;
  const known = SLUG.test(slug ?? "") && Number.isInteger(number) ? diffHeads.get(`${slug}#${number}`) ?? headOf(prRef(slug, number)) : null;
  return { slug, number, head: given ?? (known ? known.toLowerCase() : null) };
}

/** A diff value with `ciStale`: whether the PR's CI the store holds (from the poll's head) is of another commit than
 *  the diff's `head`. */
function withCi(value, slug, number) {
  const known = headOf(prRef(slug, number));
  return { ...value, ciStale: known !== null && known.toLowerCase() !== String(value.head).toLowerCase() };
}

async function diffDetail(args) {
  const slug = args?.slug;
  const number = args?.number;
  if (!SLUG.test(slug ?? "") || !Number.isInteger(number)) return badArgs("slug, number");
  let head = typeof args?.head === "string" && SHA.test(args.head) ? args.head.toLowerCase() : null;
  if (!head) {
    const now = await headNow(slug, number);
    if (now.error) return now;
    head = now.head.toLowerCase();
    if (diffHeads.size > 500) diffHeads.clear();
    diffHeads.set(`${slug}#${number}`, head);
    // A push the poll has not seen: poll soon, so the CI rows catch up.
    const known = headOf(prRef(slug, number));
    if (known && known.toLowerCase() !== head) refresh();
  }
  const got = await cached("diff", { slug, number, head }, () => prDiff({ slug, number }));
  return got.value === undefined ? got : { value: withCi(got.value, slug, number) };
}

async function cached(kind, args, fetch) {
  const key = keyOf(kind, args);
  const kept = cache.get(key);
  if (kept && Date.now() - kept.at < DETAIL_MS) return { value: kept.value };
  let job = pending.get(key);
  if (!job) {
    job = fetch()
      .catch((e) => ({ error: { kind: "other", message: errText(e) } }))
      .then((got) => {
        if (got.value !== undefined) {
          const now = Date.now();
          for (const [k, v] of cache) if (now - v.at >= DETAIL_MS) cache.delete(k);
          cache.set(key, { at: now, value: got.value });
        }
        return got;
      })
      .finally(() => pending.delete(key));
    pending.set(key, job);
  }
  return job;
}

/** A detail: resolves `{value}` or `{error: {kind, message}}` (kind "auth" | "rate" | "relay" | "other" | "bad-args"
 *  | "unknown-kind" | "moved"). threads → {threads: [{path, line, author, body, outdated, comments: [{author, body}]}],
 *  partial} (the unresolved ones); files → {files} (gh's `files` field); diff → {title, body, head, base, branch,
 *  files: [{path, additions, deletions, changeType}], diff, size, truncated, ciStale} (the first DIFF_CHARS of `gh pr
 *  diff` at commit `head`, the head GitHub reports now unless `head` is given; `size` the whole diff's length;
 *  `ciStale`: the CI the store holds is of an earlier commit; "moved" when the head kept moving while it was read); log →
 *  {source: "job"|"runs"|"commit"|"unavailable", runs: [workflow run ids read], job:
 *  jobId|null, lines} (the last 200; none when there is no failed run); failed → {source, job, jobId, step, tests,
 *  logs}. log and failed read exactly the job (`jobId`), else the workflow runs (`workflowId`), else the commit's
 *  failed runs (`sha`); with none of them they answer source "unavailable" and ask GitHub nothing. */
export function detail(kind, args) {
  if (checking()) return Promise.resolve({ error: { kind: "other", message: "checking" } });
  const fn = Object.prototype.hasOwnProperty.call(KINDS, kind) ? KINDS[kind] : null;
  if (!fn) return Promise.resolve({ error: { kind: "unknown-kind", message: String(kind) } });
  if (kind === "diff") return diffDetail(args);
  const a = argsFor(kind, args);
  return cached(kind, a, () => fn(a));
}

/** A detail already kept and still fresh, `{value, at}`, or null: for render, which must not wait. A diff is looked
 *  up at the head detail() last read for it (else the poll's), with `ciStale` as of now. */
export function peek(kind, args) {
  const a = argsFor(kind, args);
  const kept = cache.get(keyOf(kind, a));
  if (!kept || Date.now() - kept.at >= DETAIL_MS) return null;
  return kind === "diff" ? { ...kept, value: withCi(kept.value, a.slug, a.number) } : kept;
}

/** Drops the kept details of a kind (all kinds when none is given), after a change made them stale. */
export function forget(kind) {
  for (const key of [...cache.keys()]) if (!kind || key.startsWith(`${kind} `) || (kind === "log" && key.startsWith("raw-log "))) cache.delete(key);
}

// Actions.

const METHODS = [
  ["squash", "allow_squash_merge"],
  ["merge", "allow_merge_commit"],
  ["rebase", "allow_rebase_merge"],
];

/** The merge methods the repo allows, in GitHub's order (a field GitHub leaves out counts as allowed). */
async function allowedMethods(slug) {
  const r = await gh(["api", `repos/${slug}`]);
  const repo = parseJson(r.stdout);
  if (r.code !== 0 || !isObj(repo)) return { error: failure(r) };
  return { value: METHODS.filter(([, field]) => repo[field] !== false).map(([m]) => m) };
}

/** Merges a PR (`{slug | url, number}`) with `method` ("squash" | "merge" | "rebase"), else the first one the repo
 *  allows, pinned (`--match-head-commit`) to `head` (what the person saw: headOf(pr)), else to the head GitHub
 *  reports now, as upstream does. Resolves `{ok: true, method, head}` or `{error}` (kind adds "no-method"). Polls
 *  again afterwards. */
export async function merge(pr, o = {}) {
  if (checking()) return { error: { kind: "other", message: "checking" } };
  const slug = slugOf(pr);
  const number = pr?.number;
  if (!slug || !Number.isInteger(number)) return badArgs("slug, number");
  let method = typeof o.method === "string" ? o.method.toLowerCase() : null;
  if (method && !METHODS.some(([m]) => m === method)) return badArgs("method");
  if (!method) {
    const allowed = await allowedMethods(slug);
    if (allowed.error) return allowed;
    method = allowed.value[0] ?? null;
    if (!method) return { error: { kind: "no-method", message: slug } };
  }
  const argv = ["pr", "merge", String(number), "-R", slug, `--${method}`];
  let head = typeof o.head === "string" && SHA.test(o.head) ? o.head : null;
  if (!head) {
    const v = await gh(["pr", "view", String(number), "--repo", slug, "--json", "headRefOid"]);
    head = parseJson(v.stdout)?.headRefOid ?? null;
    if (v.code !== 0 || typeof head !== "string" || !SHA.test(head)) return { error: failure(v, "no head commit") };
  }
  argv.push("--match-head-commit", head);
  const r = await gh(argv, ACTION_TIMEOUT_MS);
  if (r.code !== 0) return { error: failure(r) };
  forget("threads");
  forget("files");
  forget("diff");
  svc.wanted = true;
  return { ok: true, method, head };
}

/** Reruns the failed jobs of a CI run (a Run of STORE.gh: `slug`, `workflowId` = run ids joined by ","). Resolves
 *  `{ok: true, runs: [ids]}` or `{error}`. Polls again afterwards. */
export async function rerun(run) {
  if (checking()) return { error: { kind: "other", message: "checking" } };
  const slug = typeof run?.slug === "string" && SLUG.test(run.slug) ? run.slug : null;
  const ids = String(run?.workflowId ?? "")
    .split(",")
    .filter((id) => /^\d+$/.test(id));
  if (!slug || !ids.length) return badArgs("slug, workflowId");
  for (const id of ids) {
    const r = await gh(["run", "rerun", id, "--failed", "-R", slug], ACTION_TIMEOUT_MS);
    if (r.code !== 0) return { error: failure(r) };
  }
  forget("log");
  forget("failed");
  svc.wanted = true;
  return { ok: true, runs: ids };
}
