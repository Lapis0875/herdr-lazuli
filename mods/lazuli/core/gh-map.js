// GitHub in one GraphQL query and what lazuli reads from it (ARCHITECTURE §4.1, CONTRACTS gh-map.js): my review
// requests (direct or through a team, bots apart), my open PRs with their review state and checks, what I merged these
// 30 days, and the CI run of each PR of mine. Ported from cockpit v0.38.5 `hub/src/feed/github.rs`, `github_ci.rs` and
// `hub/src/events.rs`. Pure: no herdr imports, time passed in, no user-facing text.

/** Check and status states that count as failed, for PR rows and CI runs alike (C1). */
export const FAILED = Object.freeze(["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED"]);

const DAY_MS = 86400000;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const str = (v) => (typeof v === "string" ? v : null);
const or = (v, fallback) => (v === null || v === undefined ? fallback : v);
const at = (v, ...path) => {
  let cur = v;
  for (const key of path) {
    if (cur === null || cur === undefined) return undefined;
    cur = typeof key === "number" ? (Array.isArray(cur) ? cur[key] : undefined) : isObj(cur) ? cur[key] : undefined;
  }
  return cur;
};
const has = (o, key) => isObj(o) && Object.prototype.hasOwnProperty.call(o, key);

/** The first day of the merged search, `days` before `now`, as GitHub's search writes it (UTC). */
export function mergedSince(now, days = 30) {
  const t = (Number.isFinite(now) ? now : 0) - (Number.isFinite(days) ? days : 30) * DAY_MS;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return "1970-01-01";
  return d.toISOString().slice(0, 10);
}

const PR_BASE =
  "number title url isDraft updatedAt headRefName baseRefName repository { name nameWithOwner } " +
  "author { __typename login ... on User { name } } reviewDecision";

const cleanOrg = (org) => (typeof org === "string" ? org.replace(/[^A-Za-z0-9_.-]/g, "") : "");

/** The one query of the poll. Review requests only need the rollup (listing every one's checks makes the query too
 *  heavy for GitHub); my own PRs list their first 30 checks, which give the failing names and the CI runs, with the
 *  count and the cursor sys/gh.js pages on from. `orgs` scope my PRs and my merges (settings().gh.org); each keeps
 *  only `[A-Za-z0-9_.-]`. */
export function buildQuery(o) {
  const orgs = list(o?.orgs).map(cleanOrg).filter(Boolean);
  const scope = orgs.map((org) => ` org:${org}`).join("");
  const since = typeof o?.mergedSince === "string" ? o.mergedSince.replace(/[^0-9-]/g, "") : "";
  return `query {
  review: search(query: "is:pr is:open archived:false review-requested:@me", type: ISSUE, first: 60) { nodes { __typename ... on PullRequest { ${PR_BASE} headRefOid headRepository { nameWithOwner } commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } } } }
  direct: search(query: "is:pr is:open archived:false user-review-requested:@me", type: ISSUE, first: 50) { nodes { ... on PullRequest { url } } }
  mine: search(query: "is:pr is:open archived:false author:@me${scope}", type: ISSUE, first: 30) { nodes { __typename ... on PullRequest { ${PR_BASE} id body headRepository { nameWithOwner } reviewThreads(first: 50) { totalCount pageInfo { hasNextPage endCursor } nodes { isResolved } }
    commits(last: 1) { nodes { commit { oid committedDate statusCheckRollup { state contexts(first: 30) { totalCount pageInfo { hasNextPage endCursor } nodes {
      ... on CheckRun { databaseId name status conclusion detailsUrl checkSuite { workflowRun { databaseId } } }
      ... on StatusContext { context state targetUrl } } } } } } } } } }
  merged: search(query: "is:pr is:merged author:@me${scope} merged:>=${since}", type: ISSUE, first: 50) {
    nodes { ... on PullRequest { number url headRefName createdAt mergedAt repository { name nameWithOwner } mergeCommit { oid } } } }
  rateLimit { remaining resetAt cost }
}`;
}

const isPr = (node) => isObj(node) && node.__typename === "PullRequest";
const checkState = (c) => str(at(c, "conclusion")) ?? str(at(c, "state")) ?? "";
const checkName = (c) => str(at(c, "name")) ?? str(at(c, "context")) ?? "?";

function toPr(node, direct) {
  const url = str(node.url) ?? "";
  const rollup = at(node, "commits", "nodes", 0, "commit", "statusCheckRollup");
  const failedChecks = list(at(rollup, "contexts", "nodes"))
    .filter((c) => isObj(c) && FAILED.includes(checkState(c)))
    .map((c) => or(c.name, or(c.context, "?")));
  const pr = {
    repo: or(at(node, "repository", "name"), "?"),
    slug: or(at(node, "repository", "nameWithOwner"), "?"),
    number: or(node.number, 0),
    title: or(node.title, ""),
    url,
    author: or(at(node, "author", "login"), "?"),
    authorName: or(at(node, "author", "name"), ""),
    updatedAt: or(node.updatedAt, "1970-01-01T00:00:00.000Z"),
    isDraft: or(node.isDraft, false),
    isDirect: direct.has(url),
    review: or(node.reviewDecision, null),
    ci: or(at(rollup, "state"), null),
    failedChecks,
  };
  // Unresolved threads among those listed; past a page sys/gh.js could not read, a lower bound marked `threadsPartial`.
  const threads = at(node, "reviewThreads", "nodes");
  if (Array.isArray(threads)) pr.threads = threads.filter((t) => !(isObj(t) && t.isResolved === true)).length;
  if (Array.isArray(threads) && at(node, "reviewThreads", "pageInfo", "hasNextPage") === true) pr.threadsPartial = true;
  if (typeof node.headRefName === "string") pr.branch = node.headRefName;
  if (typeof node.baseRefName === "string") pr.base = node.baseRefName;
  if (typeof node.body === "string") pr.body = node.body;
  return pr;
}

function toMerged(n) {
  const row = {
    repo: or(at(n, "repository", "name"), "?"),
    slug: or(at(n, "repository", "nameWithOwner"), "?"),
    url: or(n.url, ""),
    number: or(n.number, 0),
    branch: n.headRefName,
    mergeSha: or(at(n, "mergeCommit", "oid"), ""),
    mergedAt: or(n.mergedAt, ""),
  };
  if (typeof n.createdAt === "string") row.createdAt = n.createdAt;
  return row;
}

function rateLimitOf(v) {
  if (!isObj(v)) return null;
  return { remaining: or(v.remaining, null), resetAt: or(v.resetAt, null), cost: or(v.cost, null) };
}

/** The query's `data` → the inbox's rows. `null` (or anything that is not an object) gives every list empty. */
export function mapGithub(data) {
  const d = isObj(data) ? data : {};
  const direct = new Set(
    list(at(d, "direct", "nodes"))
      .map((n) => str(at(n, "url")))
      .filter((u) => u !== null),
  );
  const prs = list(at(d, "review", "nodes")).filter(isPr);
  const isBot = (n) => at(n, "author", "__typename") === "Bot";
  const humans = prs.filter((n) => !isBot(n)).map((n) => toPr(n, direct));
  const mineNodes = list(at(d, "mine", "nodes")).filter(isPr);
  return {
    direct: humans.filter((p) => p.isDirect),
    team: humans.filter((p) => !p.isDirect),
    botRepos: prs.filter(isBot).map((n) => str(at(n, "repository", "name")) ?? "?"),
    mine: mineNodes.map((n) => toPr(n, direct)),
    merged: list(at(d, "merged", "nodes"))
      .filter((n) => isObj(n) && n.mergeCommit !== null && n.mergeCommit !== undefined && typeof n.headRefName === "string" && n.headRefName !== "")
      .map(toMerged),
    mineNodes,
    rateLimit: rateLimitOf(d.rateLimit),
  };
}

// CI runs: one per open PR of mine, read from its head commit's checks.

/** A job of a GitHub Actions run (a check another app reports has no workflow run). */
function jobId(c) {
  const id = at(c, "databaseId");
  const run = at(c, "checkSuite", "workflowRun", "databaseId");
  return Number.isInteger(id) && id >= 0 && Number.isInteger(run) && run >= 0 ? id : null;
}

function isDone(c) {
  if (has(c, "context")) {
    const s = at(c, "state");
    return s !== "PENDING" && s !== "EXPECTED";
  }
  return at(c, "status") === "COMPLETED";
}

function outcome(c) {
  const v = checkState(c);
  if (v === "SUCCESS" || v === "NEUTRAL" || v === "SKIPPED") return "succeeded";
  if (FAILED.includes(v)) return "failed";
  return v.toLowerCase();
}

/** The CI run of each PR of mine from `mineNodes` (mapGithub's), oldest data first as GitHub gave them. A failed run
 *  names its failing check (an Actions job first) and where its log is; its failing step comes from `prev` when the
 *  same job failed on the same commit, else it is left for sys/gh.js to ask. The commit's rollup state decides the
 *  outcome beside the listed checks, so a check past the listed page (`pageInfo.hasNextPage`) still counts: GitHub's
 *  PENDING or EXPECTED keeps it running, FAILURE or ERROR makes it failed, though `failed` then names a check only
 *  when the list holds one. `total` is the commit's whole check count (`totalCount`). `pr` is the PR's URL: two PRs
 *  into one repo may share a branch name (from two forks), so a Run is matched to its PR by it. */
export function mapRuns(mineNodes, prev) {
  const cached = new Map();
  for (const r of list(prev)) {
    if (isObj(r)) cached.set(`${r.repo}/${r.branch}/${r.runId}`, r);
  }
  const out = [];
  for (const pr of list(mineNodes)) {
    const branch = str(at(pr, "headRefName"));
    const repo = str(at(pr, "repository", "name"));
    const slug = str(at(pr, "repository", "nameWithOwner"));
    if (branch === null || repo === null || slug === null) continue;
    const commit = at(pr, "commits", "nodes", 0, "commit");
    const rollup = at(commit, "statusCheckRollup");
    const state = str(at(rollup, "state"));
    const checks = list(at(rollup, "contexts", "nodes")).filter(isObj);
    const oid = str(at(commit, "oid"));
    if (oid === null || checks.length === 0) continue;
    const partial = at(rollup, "contexts", "pageInfo", "hasNextPage") === true;
    const count = at(rollup, "contexts", "totalCount");
    const total = Number.isInteger(count) && count > checks.length ? count : checks.length;
    const isRunning = checks.some((c) => !isDone(c)) || state === "PENDING" || state === "EXPECTED";
    const failures = checks.filter((c) => isDone(c) && outcome(c) === "failed");
    const failed = failures.find((c) => jobId(c) !== null) ?? failures[0] ?? null;
    const workflows = [];
    for (const c of failures) {
      if (jobId(c) === null) continue;
      const id = String(at(c, "checkSuite", "workflowRun", "databaseId"));
      if (!workflows.includes(id)) workflows.push(id);
    }
    const run = {
      repo,
      slug,
      branch,
      runId: oid,
      createdAt: or(at(commit, "committedDate"), null),
      isRunning,
      outcome: isRunning ? "running" : failed || state === "FAILURE" || state === "ERROR" ? "failed" : "succeeded",
      // Past the listed page only a settled rollup says how many are done: all of them.
      done: partial && !isRunning ? total : checks.filter(isDone).length,
      total,
    };
    const url = str(at(pr, "url"));
    if (url !== null) run.pr = url;
    if (workflows.length) run.workflowId = workflows.join(",");
    if (failed) {
      const job = jobId(failed);
      const jobText = job === null ? "" : String(job);
      const name = checkName(failed);
      const page = str(at(failed, "detailsUrl")) ?? str(at(failed, "targetUrl"));
      const logs = job !== null ? `gh run view --job ${job} --log-failed -R ${slug}` : page ?? "gh pr checks";
      const failure = { job: name, jobId: jobText, tests: [], logs };
      // A rerun keeps the commit, so only the same job's failing step is reused.
      const known = at(cached.get(`${repo}/${branch}/${oid}`), "failed");
      if (isObj(known) && known.jobId === jobText && known.job === name && typeof known.step === "string") failure.step = known.step;
      run.failed = failure;
    }
    out.push(run);
  }
  return out;
}

// Events: what changed between two answers, for routine triggers and notifications (upstream `events.rs` inbox()).

const prName = (pr) => `${at(pr, "repo") ?? "?"}#${at(pr, "number") ?? 0}`;
const textOf = (v) => (typeof v === "string" ? v : "");
const ciState = (pr) => {
  const s = at(pr, "ci");
  if (s === "FAILURE" || s === "ERROR") return "failing";
  if (s === "SUCCESS") return "passing";
  return "";
};

/** `title`: what routine words match against (`on ci-failed main`): repo#number, the PR's title, its branch and, for a
 *  failure, the failing checks. Data only, no prose. */
function titleOf(pr, extra = []) {
  return [prName(pr), textOf(at(pr, "title")), textOf(at(pr, "branch")), ...extra].filter(Boolean).join(" ");
}

function ev(kind, pr, title) {
  const url = textOf(at(pr, "url"));
  return { kind, key: url, title, url };
}

/** The events between two answers of mapGithub (`mineNodes` unused). A first answer (`before === null`) gives none.
 *  A new review request, direct or through a team, is `review_requested`. */
export function diffEvents(before, after) {
  if (!isObj(before) || !isObj(after)) return [];
  const out = [];
  for (const field of ["direct", "team"]) {
    const known = new Set(list(before[field]).map((p) => at(p, "url")));
    for (const pr of list(after[field])) {
      if (!known.has(at(pr, "url"))) out.push(ev("review_requested", pr, titleOf(pr)));
    }
  }
  const wasMine = new Map(list(before.mine).map((p) => [at(p, "url"), p]));
  for (const pr of list(after.mine)) {
    const was = wasMine.get(at(pr, "url"));
    if (!was) {
      out.push(ev("pr_opened", pr, titleOf(pr)));
      continue;
    }
    const [a, b] = [ciState(was), ciState(pr)];
    if (b === "failing" && a !== "failing") out.push(ev("ci_failed", pr, titleOf(pr, list(at(pr, "failedChecks")).filter((c) => typeof c === "string"))));
    else if (b === "passing" && a !== "passing") out.push(ev("ci_passed", pr, titleOf(pr)));
    if (at(pr, "review") !== at(was, "review")) {
      if (at(pr, "review") === "APPROVED") out.push(ev("approved", pr, titleOf(pr)));
      else if (at(pr, "review") === "CHANGES_REQUESTED") out.push(ev("changes_requested", pr, titleOf(pr)));
    }
  }
  const mergedBefore = new Set(list(before.merged).map((p) => at(p, "url")));
  for (const pr of list(after.merged)) {
    if (!mergedBefore.has(at(pr, "url"))) out.push(ev("merged", pr, titleOf(pr)));
  }
  return out;
}

// Logs.

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;
const TEST_PATTERNS = [
  /(?:^|\s)not ok \d+ - (.+?)\s*$/, // TAP (node --test, bats, prove)
  /(?:^|\s)FAILED ([^\s(][^\s]*)(?: - .*)?$/, // pytest's short summary
  /--- FAIL: (\S+) \(/, // go test
  /(?:^|\s)test (\S+) \.\.\. FAILED\b/, // cargo test
];

/** The failing test names in a CI log (`gh run view --log-failed`: job, step, then the line after the last tab),
 *  unique, in order, at most 50. */
export function failedTests(log) {
  if (typeof log !== "string") return [];
  const out = [];
  for (const raw of log.split(/\r?\n/)) {
    const line = raw.slice(raw.lastIndexOf("\t") + 1).replace(ANSI, "");
    for (const re of TEST_PATTERNS) {
      const m = re.exec(line);
      if (!m) continue;
      const name = m[1].trim();
      if (name && !out.includes(name)) out.push(name);
      break;
    }
    if (out.length >= 50) break;
  }
  return out;
}

/** The last `n` lines of a text (a final newline ends the last line rather than starting an empty one). */
export function tailLines(text, n = 200) {
  if (typeof text !== "string" || text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === "") lines.pop();
  const count = Number.isInteger(n) && n > 0 ? n : 0;
  return count ? lines.slice(-count) : [];
}

/** Why a `gh` call failed, from its exit code and stderr: not signed in, rate limited, refused by herdr-relay (a
 *  device), or something else; null when it did not fail. */
export function ghError(r) {
  const code = at(r, "code");
  if (code === 0) return null;
  const stderr = textOf(at(r, "stderr"));
  const message = stderr.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? `exit ${code}`;
  if (stderr.includes("gh auth login")) return { kind: "auth", message };
  if (/rate limit/i.test(stderr)) return { kind: "rate", message };
  if (code === 126 && stderr.trimStart().startsWith("herdr-relay:")) return { kind: "relay", message };
  return { kind: "other", message };
}
