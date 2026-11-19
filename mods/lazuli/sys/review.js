// The Review panel's data (DESIGN A3; port of cockpit 0.38.5 `herdr/tui/show/src/review.rs` and `patch.rs`): a
// repository's changes in one of three scopes, parsed into files, hunks and lines with the changed words marked,
// and the review sent to an agent as one line. The walkthrough lives in sys/review-walk.js.
//
//   uncommitted  `git diff HEAD` plus untracked files (at most 30, each as a new file)
//   branch       `git diff <merge-base HEAD base>` plus untracked files; base: origin/HEAD, else main or master
//   pr           `gh pr view --json …` and `gh pr diff --color never` for the checked-out branch, kept a minute
//
// Every command runs through `exec` with the path as an argument, on the space's machine (`on`). Module state is
// shared by every copy (F3): the last read of each place, which a preview copy draws without running anything.

import { exec, hc, checking, agents, terminals, panes } from "herdr";
import { t } from "../core/i18n.js";

const errText = (e) => String(e?.message ?? e).replace(/^`herdr\.\w+`:\s*/, "");
const firstLine = (s) => String(s ?? "").trim().split("\n").map((l) => l.trim()).find(Boolean) ?? "";

export const SCOPES = Object.freeze(["uncommitted", "branch", "pr"]);
/** Lines drawn across all files of one diff; the rest of a file is counted, not drawn. */
const SHOWN_LINES = 6000;
const UNTRACKED_MAX = 30;
const PR_MS = 60000;
const KEPT_PLACES = 8;
const GIT_MS = 30000;
/** A note line the untracked-file script prints for a file over 1 MB; the view words it. */
export const LARGE_NOTE = "@@lazuli-large@@";

/** FNV-1a over a string's UTF-16 units, 8 hex digits. */
export function fnv(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------------------------------------------------
// The patch: files, lines `[kind, old, new, text, marks?]` (kind "@" hunk header, "+", "-", " ", "!" note; `marks`:
// `[start, end]` ranges of the changed words), hunks `{id, at, end, header}` with ids that survive moved lines.

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const SKIPPED = ["index ", "new file", "deleted file", "similarity", "dissimilarity", "rename ", "copy ", "old mode", "new mode", "--- "];
const expand = (s) => s.replace(/\t/g, "    ");

/** A unified diff (git's, gh's) → files with their lines; numbers as git counts them. */
export function parsePatch(patch) {
  const files = [];
  let old = 0, now = 0, oldLeft = 0, newLeft = 0;
  const raws = String(patch ?? "").split("\n");
  if (raws[raws.length - 1] === "") raws.pop();
  const last = () => files[files.length - 1];
  for (const raw of raws) {
    if (oldLeft > 0 || newLeft > 0) {
      const cur = last();
      if (!cur) break;
      const c = raw[0];
      if (c === "+") {
        cur.added++;
        cur.lines.push(["+", null, now++, expand(raw.slice(1))]);
        newLeft = Math.max(0, newLeft - 1);
      } else if (c === "-") {
        cur.removed++;
        cur.lines.push(["-", old++, null, expand(raw.slice(1))]);
        oldLeft = Math.max(0, oldLeft - 1);
      } else if (c === "\\") cur.lines.push(["!", null, null, raw]);
      else {
        cur.lines.push([" ", old++, now++, expand(raw.slice(1))]);
        oldLeft = Math.max(0, oldLeft - 1);
        newLeft = Math.max(0, newLeft - 1);
      }
      continue;
    }
    if (raw.startsWith("diff --git ")) {
      const rest = raw.slice(11);
      const at = rest.indexOf(" b/");
      files.push({ path: at >= 0 ? rest.slice(at + 3) : rest, added: 0, removed: 0, lines: [] });
      continue;
    }
    if (raw.startsWith("--- ") && (!last() || last().lines.length)) {
      const p = raw.slice(4).split("\t")[0];
      files.push({ path: p.startsWith("a/") ? p.slice(2) : p, added: 0, removed: 0, lines: [] });
      continue;
    }
    const cur = last();
    if (!cur) continue;
    if (raw.startsWith("\\")) cur.lines.push(["!", null, null, raw]);
    else if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).split("\t")[0];
      if (p !== "/dev/null") cur.path = p.startsWith("b/") ? p.slice(2) : p;
    } else {
      const m = HUNK.exec(raw);
      if (m) {
        [old, oldLeft, now, newLeft] = [Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
        cur.lines.push(["@", null, null, raw]);
      } else if (raw && !SKIPPED.some((s) => raw.startsWith(s))) cur.lines.push(["!", null, null, raw]);
    }
  }
  return files;
}

const TOKEN = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu;
const COMPARED = 2000;

/** The changed ranges of a removed line and the added line facing it, or null when they share too little. */
export function changedWords(a, b) {
  if (a.length > COMPARED || b.length > COMPARED) return null;
  const x = a.match(TOKEN) ?? [];
  const y = b.match(TOKEN) ?? [];
  if (x.length * y.length > 40000) return null;
  const dp = Array.from({ length: x.length + 1 }, () => new Uint16Array(y.length + 1));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const gone = [], came = [];
  let i = 0, j = 0, o = 0, n = 0, same = 0;
  const push = (list, at, len) => {
    const prev = list[list.length - 1];
    if (prev && prev[1] === at) prev[1] = at + len;
    else list.push([at, at + len]);
  };
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) {
      same += x[i].trim().length;
      o += x[i++].length;
      n += y[j++].length;
    } else if (j < y.length && (i >= x.length || dp[i][j + 1] >= dp[i + 1][j])) {
      push(came, n, y[j].length);
      n += y[j++].length;
    } else {
      push(gone, o, x[i].length);
      o += x[i++].length;
    }
  }
  const longest = Math.max(a.trim().length, b.trim().length);
  return same * 5 >= longest * 2 ? [gone, came] : null;
}

const MARK = { "@": "@", "+": "+", "-": "-", " ": " ", "!": "" };

/** A file's hunks: `{id, at, end, header}`; an id is the path and a hash of the hunk's lines (not their place). */
export function hunksOf(file) {
  const starts = [];
  file.lines.forEach((l, i) => l[0] === "@" && starts.push(i));
  const out = [];
  starts.forEach((at, k) => {
    const end = starts[k + 1] ?? file.lines.length;
    const body = file.lines.slice(at + 1, end).map((l) => `${MARK[l[0]]}${l[3]}\n`).join("");
    const id = `${file.path}:${fnv(body)}`;
    const seen = out.filter((h) => h.id === id || h.id.startsWith(`${id}-`)).length;
    out.push({ id: seen ? `${id}-${seen + 1}` : id, at, end, header: file.lines[at][3] });
  });
  return out;
}

/** The patch as the view draws it: `{hash, files, added, removed}`; a file past SHOWN_LINES keeps `more`. */
export function diffModel(patch) {
  const files = parsePatch(patch);
  let sent = 0;
  for (const f of files) {
    f.hunks = hunksOf(f);
    for (let i = 0; i < f.lines.length; ) {
      let d = i;
      while (d < f.lines.length && f.lines[d][0] === "-") d++;
      let a = d;
      while (a < f.lines.length && f.lines[a][0] === "+") a++;
      for (let k = 0; k < Math.min(d - i, a - d); k++) {
        const marks = changedWords(f.lines[i + k][3], f.lines[d + k][3]);
        if (marks) {
          f.lines[i + k][4] = marks[0];
          f.lines[d + k][4] = marks[1];
        }
      }
      i = Math.max(a, i + 1);
    }
    const shown = Math.min(f.lines.length, Math.max(0, SHOWN_LINES - sent));
    sent += shown;
    f.more = f.lines.length - shown;
    f.lines = f.lines.slice(0, shown);
  }
  return { hash: patchHash(patch), files, added: files.reduce((s, f) => s + f.added, 0), removed: files.reduce((s, f) => s + f.removed, 0) };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading a scope.

const GIT = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.quotepath=false"];

async function git(repo, args, on) {
  try {
    const r = await exec("git", [...GIT, "-C", repo, ...args], { on, timeout: GIT_MS });
    return r.code === 0 ? { ok: true, out: r.stdout } : { ok: false, code: r.code, err: firstLine(r.stderr) || `git ${args[0]}: ${r.code}` };
  } catch (e) {
    return { ok: false, err: errText(e) };
  }
}

async function gh(repo, args, on) {
  try {
    const r = await exec("gh", args, { cwd: repo, on, timeout: GIT_MS });
    return r.code === 0 ? { ok: true, out: r.stdout } : { ok: false, err: firstLine(r.stderr) || `gh ${args[0]}: ${r.code}` };
  } catch (e) {
    return { ok: false, err: errText(e) };
  }
}

// A new file reads as git shows one: `git diff --no-index /dev/null <file>`, one call for them all.
// A vanished file is skipped; any other failure (unreadable file, git error) fails the whole read with exit 4, so
// untracked changes are never silently left out of a diff that then reads as clean.
const UNTRACKED = [
  'cd "$1" || exit 3; shift; rc=0',
  "for f; do",
  '  [ -e "$f" ] || [ -L "$f" ] || continue',
  "  size=$(wc -c < \"$f\" 2>/dev/null | tr -d ' ')",
  `  if [ "\${size:-0}" -gt 1000000 ] 2>/dev/null; then printf 'diff --git a/%s b/%s\\nnew file mode 100644\\n${LARGE_NOTE}\\n' "$f" "$f"; continue; fi`,
  "  git --no-pager -c core.quotepath=false diff --no-color --no-ext-diff --no-index -- /dev/null \"$f\"; s=$?",
  '  [ "$s" -le 1 ] || { echo "untracked $f: git diff exited $s" >&2; rc=4; }',
  "done; exit $rc",
].join("\n");

async function workingDiff(repo, base, on) {
  const d = await git(repo, ["diff", "--no-color", "--no-ext-diff", base, "--"], on);
  if (!d.ok) return { error: { code: "git", detail: d.err } };
  // Untracked files are part of the changes: a failed listing fails the read rather than reading as clean.
  const u = await git(repo, ["ls-files", "--others", "--exclude-standard", "-z"], on);
  if (!u.ok) return { error: { code: "git", detail: u.err } };
  const files = u.out.split("\0").filter(Boolean).slice(0, UNTRACKED_MAX);
  if (!files.length) return { patch: d.out };
  let r;
  try {
    r = await exec("sh", ["-c", UNTRACKED, "lazuli-review", repo, ...files], { on, timeout: GIT_MS });
  } catch (e) {
    return { error: { code: "git", detail: errText(e) } };
  }
  if (r.code !== 0) return { error: { code: "git", detail: firstLine(r.stderr) || `untracked files: exit ${r.code}` } };
  return { patch: d.out + r.stdout };
}

async function baseOf(repo, on) {
  const head = await git(repo, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], on);
  if (head.ok && head.out.trim()) return head.out.trim();
  for (const b of ["origin/main", "main", "origin/master", "master"]) if ((await git(repo, ["rev-parse", "--verify", "--quiet", b], on)).ok) return b;
  return null;
}

const prs = new Map();

async function pullRequest(repo, branch, on) {
  const key = `${on ?? ""}|${repo}|${branch}`;
  const kept = prs.get(key);
  if (kept && Date.now() - kept.at < PR_MS) return kept.value;
  const facts = await gh(repo, ["pr", "view", "--json", "number,title,url,baseRefName,headRefName,state,isDraft"], on);
  let value;
  if (!facts.ok) value = { error: { code: "gh", detail: facts.err } };
  else {
    const diff = await gh(repo, ["pr", "diff", "--color", "never"], on);
    let pr = null;
    try {
      pr = JSON.parse(facts.out);
    } catch {
      pr = null;
    }
    value = !diff.ok ? { error: { code: "gh", detail: diff.err } } : pr ? { pr, patch: diff.out } : { error: { code: "gh", detail: firstLine(facts.out) } };
  }
  prs.set(key, { at: Date.now(), value });
  return value;
}

/** HEAD's commit for the uncommitted scope: "HEAD", or git's empty tree in a repository with no commits yet (HEAD
 *  names a branch that does not exist: `rev-parse --verify -q` fails quietly and `symbolic-ref -q` succeeds). Other
 *  failures stay errors. `{base, branch}` or `{error}`. */
async function headOf(repo, on) {
  const head = await git(repo, ["rev-parse", "--verify", "-q", "HEAD"], on);
  if (head.ok) return { base: "HEAD", branch: null };
  const sym = head.code === 1 ? await git(repo, ["symbolic-ref", "-q", "--short", "HEAD"], on) : null;
  if (!sym?.ok) return { error: { code: "git", detail: head.err } };
  const empty = await git(repo, ["hash-object", "-t", "tree", "/dev/null"], on);
  if (!empty.ok) return { error: { code: "git", detail: empty.err } };
  return { base: empty.out.trim(), branch: sym.out.trim() };
}

/** The scope's patch and what the header says about it: `{patch, about}` or `{error: {code, detail?, vars?}}`. */
async function patchOf(repo, scope, on) {
  const branch = (await git(repo, ["rev-parse", "--abbrev-ref", "HEAD"], on)).out?.trim() ?? "";
  if (scope === "branch") {
    const base = await baseOf(repo, on);
    if (!base) return { error: { code: "no-base" } };
    const fork = await git(repo, ["merge-base", "HEAD", base], on);
    if (!fork.ok) return { error: { code: "no-history", vars: { branch, base } } };
    const sha = fork.out.trim();
    const ahead = Number((await git(repo, ["rev-list", "--count", `${sha}..HEAD`], on)).out?.trim()) || 0;
    const d = await workingDiff(repo, sha, on);
    return d.error ? d : { patch: d.patch, about: { branch, base, commits: ahead } };
  }
  if (scope === "pr") {
    const p = await pullRequest(repo, branch, on);
    return p.error ? p : { patch: p.patch, about: { branch, base: p.pr.baseRefName ?? null, pr: p.pr } };
  }
  const head = await headOf(repo, on);
  if (head.error) return head;
  const d = await workingDiff(repo, head.base, on);
  return d.error ? d : { patch: d.patch, about: { branch: head.branch ?? branch, base: "HEAD" } };
}

const places = new Map();
const placeKey = (repo, scope, on) => `${on ?? ""}|${repo}|${scope}`;

/** The last read of a folder's scope (null before one), safe in render: what a preview copy draws. */
export function lastRead(folder, scope, on) {
  for (const p of places.values()) if (p.scope === scope && (p.on ?? null) === (on ?? null) && (p.folder === folder || p.repo === folder)) return p;
  return null;
}

/**
 * Reads a folder's repository in one scope: `{repo, name, scope, on, about, model, place}`, or `{error, repo?}`
 * (`error`: `{code, detail?, vars?}`; codes not-repo, no-base, no-history, git, gh). `since`: the hash the caller
 * draws; an unchanged read answers `{same: true}` with the rest.
 */
export async function read({ folder, scope, on = null, since = null }) {
  if (checking()) return { error: { code: "not-repo", vars: { folder } } };
  const top = await git(folder, ["rev-parse", "--show-toplevel"], on);
  if (!top.ok) return { error: { code: "not-repo", vars: { folder } } };
  const repo = top.out.trim();
  const got = await patchOf(repo, scope, on);
  const key = placeKey(repo, scope, on);
  const name = repo.split("/").pop();
  if (got.error) return { error: got.error, repo, name, scope, on };
  const kept = places.get(key);
  // The same patch as the last read: nothing is parsed again; the caller drawing it hears `same`.
  if (kept && kept.model.hash === patchHash(got.patch)) {
    Object.assign(kept, { folder, about: got.about, at: Date.now() });
    return since === kept.model.hash ? { ...kept, same: true } : kept;
  }
  const model = diffModel(got.patch);
  places.delete(key);
  places.set(key, { repo, folder, name, scope, on, about: got.about, model, patch: got.patch, place: fnv(key), at: Date.now() });
  while (places.size > KEPT_PLACES) places.delete(places.keys().next().value);
  return places.get(key);
}

/** A patch's identity: its hash and length. */
export function patchHash(patch) {
  return `${fnv(patch)}${patch.length.toString(16)}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// The review sent to the agent: one line (a newline would send it early), each comment numbered with its place.

// Control characters (escape sequences in quoted repo code, or a stray carriage return) never reach the terminal.
const oneLine = (s) => String(s ?? "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, " ").split(/\s+/).filter(Boolean).join(" ");

/** The review as the agent reads it, in the UI language; null without comments. */
export function message(scope, comments) {
  if (!comments?.length) return null;
  const items = comments.map((c, i) => {
    const code = oneLine(c.code).slice(0, 80);
    return t("review.message.item", {
      n: i + 1,
      place: oneLine(`${c.path}:${c.line}`),
      side: c.old ? t("review.message.removed") : "",
      code: code ? ` \`${code}\`` : "",
      text: oneLine(c.text),
    });
  });
  return t("review.message.head", { what: t(`review.message.what.${SCOPES.includes(scope) ? scope : "uncommitted"}`), count: comments.length, items: items.join(" ") });
}

/** The machine a terminal address lives on (`mini/t3` → "mini"), or null for this computer. */
export const machineOf = (address) => (typeof address === "string" && address.includes("/") ? address.slice(0, address.indexOf("/")) : null);

/** Whether `address` is an agent's live terminal right now (agents() lists it; terminals() does not call it
 *  ended). A plain shell never qualifies. Safe in render. */
export function isAgentTerminal(address) {
  if (typeof address !== "string" || !address) return false;
  if (!(agents() ?? []).some((a) => a.address === address)) return false;
  const term = (terminals() ?? []).find((x) => x.address === address);
  return !term?.state || term.state === "live";
}

/** Why the review cannot go to `address` for `repo` on machine `on` now, or null: no-agent (none, or not an agent
 *  terminal), other-machine (it lives on another machine than the changes), other-repo (it works outside that
 *  repository now, or its folder is unknown). */
export async function recipientProblem(address, repo, on) {
  if (!isAgentTerminal(address)) return "no-agent";
  // The terminal lives on the machine the changes were read on: never a local review to a remote agent.
  if (machineOf(address) !== (on ?? null)) return "other-machine";
  const term = (terminals() ?? []).find((x) => x.address === address);
  const cwd = (panes() ?? []).find((p) => p.terminal === address)?.cwd ?? term?.cwd ?? term?.foreground?.cwd ?? null;
  if (!cwd || !repo) return "other-repo";
  const top = await git(cwd, ["rev-parse", "--show-toplevel"], on ?? null);
  return top.ok && top.out.trim() === repo ? null : "other-repo";
}

/**
 * Types the review into the agent that the comments were written for: `to` = `{address, repo, on, scope}`, the
 * context bound when the diff loaded. Right before delivery the recipient is checked again: a live agent terminal
 * working in that repository. Returns `{ok, count}` or `{error: "empty" | "no-agent" | "other-machine" | "other-repo" |
 * "not-taken"}`;
 * on an error nothing was typed anywhere.
 */
export async function send(to, comments) {
  const line = message(to?.scope, comments);
  if (!line) return { error: "empty" };
  const problem = await recipientProblem(to?.address, to?.repo, to?.on);
  if (problem) return { error: problem };
  try {
    const r = await hc(["send", to.address, "--", line]);
    return r.code === 0 ? { ok: true, count: comments.length } : { error: "not-taken" };
  } catch {
    return { error: "not-taken" };
  }
}
