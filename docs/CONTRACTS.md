# lazuli core module contracts

Read before writing: T01's `main.js`, `sys/state.js`, `sys/store.js`, `sys/bus.js`, `core/i18n.js`, `core/catalog/index.js`. Nothing here changes those files.

## Conventions (all `core/*.js`)

- ES modules, named exports only. Imports: relative `core/` files only; `md-tree.js` also imports `../vendor/marked.esm.js`.
- **No function throws for JSON-like input.** Bad data returns the documented `null`, `{error}` or unchanged value.
- Inputs are never mutated; results are new objects.
- **Time:** `now` is always an argument (epoch ms). Local-time rules use `Date` local getters. Tests write `L(y,m,d,h,mi) = new Date(y, m-1, d, h, mi).getTime()` on both sides.
- **Random and hashing** are passed in (`fid`, `hash`). `Date.now`, `Math.random` and `crypto` never appear in `core/`.
- **User-facing text is never produced in `core/`**: functions return codes; views map them to catalog keys.
- `Tokens = {input, output, cacheRead, cacheWrite, cacheWrite1h}` (numbers; missing = 0).

## Changes from ARCHITECTURE §1–§9

| # | Change | Where |
|---|---|---|
| C1 | PR rows gain `slug` (owner/name) and `body`; the image-job field (`dockerTag`) is dropped; one failed-state list of 6 serves both rows and runs. | §4.1 |
| C2 | Stage precedence is fixed: blocked > working > PR needs a fix > ready > done; an active snooze gives `done`. | §4.2 |
| C3 | Queue and routine results carry codes (`note`, `error`) and a structured `why`, not English sentences. | §4.6, §4.7 |
| C4 | Headless omp is `omp -p --session-dir <dir> -- <prompt>`; its cost is read from that session file with `spend.ompUsage`, not from `--mode json`. | §4.8 |
| C5 | Run files gain `<base>.pid`; `<base>.exit` has two more fields (`timedOut`, `error`). | §4.6, §4.8 |
| C6 | Resume record field `tried` is `{pid, at, failed}`; the record's `pid` stays the old shell's until the tool runs again. | §7 |
| C7 | `drafts.js` and `tabs-reg.js` take hashes and ids as arguments; `sys/filetabs.js` computes sha1 with the `crypto` module. | §6 |
| C8 | `proto.js` frames bytes (`Uint8Array`) and ships its own UTF-8 decoder. | §5 |
| C9 | Codex spend is counted as deltas between successive `token_count` totals, each dated by its own record. | §4.3 |

## gh-map.js

```js
export const FAILED: readonly string[]  // FAILURE ERROR TIMED_OUT CANCELLED STARTUP_FAILURE ACTION_REQUIRED
export function mergedSince(now: number, days = 30): string                    // "YYYY-MM-DD", UTC
export function buildQuery(o: {orgs?: string[], mergedSince: string}): string  // orgs from settings().gh.org
export function mapGithub(data: object|null): Github
export function mapRuns(mineNodes: object[], prev?: Run[]|null): Run[]
export function diffEvents(before: Github|null, after: Github): GhEvent[]
export function failedTests(log: string): string[]                             // unique, in order, at most 50
export function tailLines(text: string, n = 200): string[]
export function ghError(r: {code: number, stderr: string}): null | {kind: "auth"|"rate"|"relay"|"other", message: string}
```
- `Pr = {repo, slug, number, title, url, author, authorName, updatedAt, isDraft, isDirect, review, ci, failedChecks: string[], threads?, threadsPartial?, branch?, base?, body?}`. `threads` = unresolved count; `threads`, `branch`, `base`, `body` are present only when the node has them. `threadsPartial: true` (review fix r5) only when thread pages remain unread; `threads` is then a lower bound.
- `Github = {direct: Pr[], team: Pr[], botRepos: string[], mine: Pr[], merged: Merged[], mineNodes: object[], rateLimit: {remaining, resetAt, cost}|null}`; `Merged = {repo, slug, url, number, branch, mergeSha, mergedAt, createdAt?}`. `mapGithub(null)` gives all lists empty.
- `Run = {repo, slug, branch, runId, createdAt, isRunning, outcome: "running"|"failed"|"succeeded", done, total, pr, workflowId?, failed?: {job, jobId, step?, tests: [], logs}}`. `pr` (review fix r5) = the PR URL the run belongs to; `gh.runOf(pr)` matches by it (slug + branch only for an old Run without `pr`, and only when exactly one matches). `step` is copied from `prev` when repo, branch, runId, jobId and job all match; otherwise absent (`sys/gh.js` fills it).
- `GhEvent = {kind, key, title, url}`, `key` = PR URL. Kinds: `review_requested pr_opened approved changes_requested merged ci_failed ci_passed`. `before === null` → `[]`.
- `buildQuery` keeps only `[A-Za-z0-9_.-]` in each org, adds one ` org:<name>` per org to the `mine` and `merged` searches, and asks for `body` on `mine` and for `rateLimit{remaining resetAt cost}`. Review fix r4 (additive): `mine`'s `contexts(first: 30)` also asks for `totalCount pageInfo{hasNextPage endCursor}`; `sys/gh.js` pages in the remaining contexts by commit oid (≤ 3 pages of 100 per PR) before `mapGithub`. Review fix r5 (additive): `mine` also asks for `id`, `headRepository{nameWithOwner}` and `reviewThreads(first: 50){totalCount pageInfo{hasNextPage endCursor} …}`; remaining threads are paged by PR id (≤ 5 pages of 100).
- Review fix (focused review): the review search also asks for `headRefOid headRepository { nameWithOwner }`, kept by `sys/gh.js` per section, so `gh.headOf`/`gh.ciArgs` cover review rows; without a job id, workflow id or sha, CI details come back `source: "unavailable"` with no gh call (no branch-wide fallback). `gh.detail("diff", {slug, number})` → `{title, body, head, base, branch, files, diff, size, truncated}` (diff cut at a line end within 200,000 characters); all of it is untrusted PR data. `mapGithub` output is unchanged.
- `mapRuns` reads `statusCheckRollup.state`: PENDING/EXPECTED → running; FAILURE/ERROR → `outcome: "failed"` even when no listed check failed (then `failed`/`workflowId` are absent). `total` = `totalCount` when larger than the listed nodes; a settled partial list reports `done = total`.
- `failedTests` reads the text after the last tab of each line and matches: `not ok N - <name>`, `FAILED <id> - …`, `--- FAIL: <name> (`, `test <name> ... FAILED`.
- `ghError`: code 0 → `null`; stderr with `gh auth login` → `auth`; `rate limit` → `rate`; code 126 and stderr starting `herdr-relay:` → `relay`.

```js
const node = {__typename:"PullRequest",number:4,title:"Google sign-in",url:"https://github.com/acme/api/pull/4",isDraft:false,updatedAt:"2026-10-27T15:53:26Z",headRefName:"me/eng-401-login",baseRefName:"main",body:"Fixes https://linear.app/acme/issue/ENG-401/x",repository:{name:"api",nameWithOwner:"acme/api"},author:{__typename:"User",login:"me",name:"Me Too"},reviewDecision:"CHANGES_REQUESTED",reviewThreads:{nodes:[{isResolved:false},{isResolved:true}]},commits:{nodes:[{commit:{oid:"c0ffee4",committedDate:"2026-10-27T15:50:00Z",statusCheckRollup:{state:"FAILURE",contexts:{nodes:[{databaseId:111,name:"lint",status:"COMPLETED",conclusion:"FAILURE",detailsUrl:"https://x/1",checkSuite:{workflowRun:{databaseId:900}}},{context:"ci/circleci: test",state:"ERROR",targetUrl:"https://x/2"},{databaseId:112,name:"build",status:"COMPLETED",conclusion:"SUCCESS",checkSuite:{workflowRun:{databaseId:900}}}]}}}}]}};
mapGithub({review:{nodes:[]},direct:{nodes:[]},mine:{nodes:[node]},merged:{nodes:[]}}).mine[0]
// → {repo:"api",slug:"acme/api",number:4,title:"Google sign-in",url:"https://github.com/acme/api/pull/4",author:"me",authorName:"Me Too",updatedAt:"2026-10-27T15:53:26Z",isDraft:false,isDirect:false,review:"CHANGES_REQUESTED",ci:"FAILURE",failedChecks:["lint","ci/circleci: test"],threads:1,branch:"me/eng-401-login",base:"main",body:"Fixes https://linear.app/acme/issue/ENG-401/x"}
mapRuns([node]) // → [{repo:"api",slug:"acme/api",branch:"me/eng-401-login",runId:"c0ffee4",createdAt:"2026-10-27T15:50:00Z",isRunning:false,outcome:"failed",done:3,total:3,pr:"https://github.com/acme/api/pull/4",workflowId:"900",failed:{job:"lint",jobId:"111",tests:[],logs:"gh run view --job 111 --log-failed -R acme/api"}}]
buildQuery({orgs:['acme" evil'],mergedSince:"2026-09-28"}) // contains 'author:@me org:acmeevil"' and 'merged:>=2026-09-28'; with orgs:[] it contains no "org:"
failedTests("b\tTest\t2026-01-01T00:00:00Z not ok 3 - parses cron\nb\tTest\t2026-01-01T00:00:01Z FAILED tests/test_a.py::test_x - AssertionError\nb\tTest\t2026-01-01T00:00:02Z --- FAIL: TestSum (0.00s)") // → ["parses cron","tests/test_a.py::test_x","TestSum"]
```

## ticket.js

```js
export function ticketOf(o: {body?: string|null, branch?: string|null}): {key: string, url: string|null} | null
```
First match in `body` wins: Linear `https://linear.app/<ws>/issue/<KEY-n>[/…]`, Jira `https://<host>/browse/<KEY-n>`, GitHub `https://github.com/<o>/<r>/issues/<n>` (key `o/r#n`). Trailing `.,)` is cut from the URL. Otherwise the branch: `(?:^|[/_-])([A-Za-z]{2,10}-\d+)(?=$|[/_-])`, upper-cased, `url: null`.

```js
ticketOf({body:"Fixes https://linear.app/acme/issue/ENG-401/sign-in",branch:"me/x"}) // → {key:"ENG-401",url:"https://linear.app/acme/issue/ENG-401/sign-in"}
ticketOf({body:"see https://acme.atlassian.net/browse/OPS-7.",branch:"main"})       // → {key:"OPS-7",url:"https://acme.atlassian.net/browse/OPS-7"}
ticketOf({body:"",branch:"me/eng-401-login"})                                        // → {key:"ENG-401",url:null}
ticketOf({body:null,branch:"main"})                                                  // → null
```

## stage.js

```js
export const STAGES: readonly ["needs","working","ready","done"]
export function stageOf(a: {status, pr?: {review, ci, isDraft, threads, threadsPartial?}|null, subagents?: number, snoozedUntil?: number|null}, now = 0): Stage
export function counts(list: {stage: Stage}[]): {needs: number, working: number, ready: number, done: number}
export function nextInStage(list: {address: string, stage: Stage}[], stage: Stage, current: string|null): string|null
```
Order of rules:
1. `snoozedUntil > now` → `done`.
2. status `blocked` → `needs`.
3. status `working`, or `subagents > 0` → `working`.
4. PR with `review === "CHANGES_REQUESTED"`, `ci` in `FAILURE|ERROR`, or `threads > 0` → `needs`.
5. PR `APPROVED`, `ci === "SUCCESS"`, not draft, and `threadsPartial !== true` → `ready` (review fix: unread thread pages never make a PR ready).
6. Otherwise `done`.

`nextInStage` returns the first address of that stage after `current` in list order, wrapping; `null` when none.

```js
const ok = {review:"APPROVED",ci:"SUCCESS",isDraft:false,threads:0};
stageOf({status:"blocked",pr:ok}) // → "needs"      stageOf({status:"idle",pr:ok}) // → "ready"
stageOf({status:"working",pr:{...ok,review:"CHANGES_REQUESTED"}}) // → "working"     stageOf({status:"done",pr:null,subagents:2}) // → "working"
stageOf({status:"idle",pr:{...ok,ci:"FAILURE"},snoozedUntil:2000},1000) // → "done"; with now 3000 → "needs"
nextInStage([{address:"t1",stage:"needs"},{address:"t2",stage:"done"},{address:"t3",stage:"needs"}],"needs","t3") // → "t1"
```

## ledger.js

```js
export const CHECKPOINT_MS = 60000, KEEP_MS = 35 * 86400000
export function tick(open: {[terminal]: {start, ticket}}, working: {terminal, ticket}[], now): {open, done: Stretch[]}
export function parseLedger(text: string, since = 0): Stretch[]   // keeps end > since; bad lines skipped
export function formatStretches(list: Stretch[]): string          // JSON lines, "\n"-terminated; end <= start skipped
export function covered(intervals: [number, number][], from: number, to: number): number   // seconds, overlaps once
export function dayAndWeekStart(now): {day: number, week: number}  // local midnight; Monday local midnight
export function totals(list: Stretch[], now): {tickets: {[k]: {today, week}}, agents: {[terminal]: number}, days: string[], week: {[k]: number[]}}
export function mergeStretches(list: Stretch[]): Stretch[]       // review fix: touching stretches of one terminal + ticket become one; invalid entries dropped; totals unchanged
```
`Stretch = {start, end, ticket, terminal}`. A terminal whose ticket changed closes its stretch and opens a new one. Empty tickets count for `agents` only. `sys/fleet.js` writes the ledger only by compare-and-write; past 900,000 characters (or at the daily trim) it compacts with `mergeStretches`, then 35 days, then 2 weeks, then this week.

```js
tick({},[{terminal:"t1",ticket:"ENG-1"}],1000)   // → {open:{t1:{start:1000,ticket:"ENG-1"}},done:[]}
tick({t1:{start:1000,ticket:"ENG-1"}},[{terminal:"t1",ticket:"ENG-1"}],61000) // → {open:{t1:{start:61000,ticket:"ENG-1"}},done:[{start:1000,end:61000,ticket:"ENG-1",terminal:"t1"}]}
covered([[0,10000],[5000,15000],[20000,21000]],0,100000) // → 16        covered([[0,10000]],4000,6000) // → 2
// N=L(2026,11,4,12,0), h=3600000: totals([{start:N-2*h,end:N-h,ticket:"ENG-1",terminal:"a"},{start:N-2*h,end:N-h,ticket:"ENG-1",terminal:"b"},{start:N-30*h,end:N-29*h,ticket:"ENG-1",terminal:"a"}],N)
//   .tickets["ENG-1"] → {today:3600,week:7200}; .agents.a → 3600; .days[0] → "2026-11-02"; .week["ENG-1"].slice(1,3) → [3600,3600]
```

## todo-doc.js

```js
export const NEW_FILE = "# To-do\n\n"
export function parse(text: string): Doc              // Doc = {lines: string[]}
export function text(doc): string
export function items(doc): {line: number, done: boolean, text: string}[]
export function add(doc, text: string): Doc           // newlines → one space; empty after trim → same doc
export function set(doc, line, done, text): Doc       // rewrites the line as "- [ ] text" (indentation lost, as upstream)
export function remove(doc, line): Doc
export function place(doc, from, to): Doc
export function order(doc): Doc
export function toggle(doc, line, today: string): Doc // today "YYYY-MM-DD"
export function undated(text: string): string
export function links(text: string, o?: {repo?: string}): {kind: "url"|"ref", label: string, url: string}[]
```
A line index out of range, or one that is not an item for `toggle`, returns the same doc. `links`: `https?://…`; `owner/repo#n` and (with `repo`) `#n` → `https://github.com/<slug>/issues/<n>`.

```js
text(add(parse(NEW_FILE),"first")) // → "# To-do\n\n- [ ] first\n"; adding "second" after it → "# To-do\n\n- [ ] second\n- [ ] first\n"
items(parse("# To-do\n\n- [ ] one\n  - [x] two (done 2026-10-27)\nnotes\n"))[1] // → {line:3,done:true,text:"two (done 2026-10-27)"}
text(toggle(parse("# To-do\n\n- [ ] a\n- [ ] b\n- [x] c (done 2026-10-01)\n"),2,"2026-10-28")) // → "# To-do\n\n- [ ] b\n- [x] a (done 2026-10-28)\n- [x] c (done 2026-10-01)\n"
links("review acme/api#4 and #7",{repo:"acme/web"}) // → [{kind:"ref",label:"acme/api#4",url:"https://github.com/acme/api/issues/4"},{kind:"ref",label:"#7",url:"https://github.com/acme/web/issues/7"}]
```

## queue-doc.js

```js
export function emptyDoc(): QueueDoc                          // {version: 1, queues: {}}
export function normalize(raw: unknown): QueueDoc             // drops what is not {id: string, text: string, at: number}
export function count(doc): number
export function prompt(texts: string[]): string
export function edit(doc, action: string, args: unknown[], now: number): {doc, note, texts: string[]} | {error}
```
- Actions and args as upstream: `add [h, text]`, `edit [h, id, text]`, `remove [h, id]`, `move [h, id, to]`, `clear [h]`, `send [h, id|"all"]`.
- `note`: `"queued" | "nothing-to-add" | "sent" | "nothing-queued" | ""`. `error`: `"no-agent" | "not-in-queue" | "unknown-action"`.
- New id: `q<now>-<length before the add>`. Empty queues are removed from the doc.
- `send` returns the doc without the sent items; the caller restores the previous doc when `hc send` fails.

```js
let r = edit(emptyDoc(),"add",["t3","run the tests"],1);  // r.note "queued"; r.doc.queues.t3 → [{id:"q1-0",text:"run the tests",at:1}]
r = edit(r.doc,"add",["t3","then push"],2);               // second id "q2-1";   edit(r.doc,"add",["t3","  "],3).note → "nothing-to-add"
r = edit(r.doc,"move",["t3","q2-1",0],4); r = edit(r.doc,"send",["t3","all"],5); // → {note:"sent",texts:["then push","run the tests"],doc:{version:1,queues:{}}}
prompt(r.texts) // → "1. then push\n2. run the tests"     prompt(["one"]) // → "one"     edit(r.doc,"remove",["t3","q9"],6) // → {error:"not-in-queue"}
```

## pricing.js and spend.js

```js
// pricing.js: USD per million tokens
export const RATES: {[modelPrefix: string]: Rate}   // Rate = {input, output, cacheRead, cacheWrite, cacheWrite1h?}
export function rateFor(model: string|null, rates = RATES): Rate|null   // lower-cased; exact key, else the longest key that prefixes it
export function cost(tokens: Tokens, rate: Rate): number                // cacheWrite1h rate defaults to cacheWrite
// spend.js
export function ompUsage(record: object): Entry|null
export function claudeUsage(record: object): Entry|null
export function codexTotal(record: object): Tokens|null
export function codexDelta(prev: Tokens|null, total: Tokens): Tokens    // per field max(0, total - prev); total below prev → total
export function price(entry: Entry, rates = RATES): Entry               // keeps a non-null usd, else cost() or null
export function summarize(entries: Entry[], now: number): Report
```
- `Entry = {tool: "omp"|"claude"|"codex", model: string|null, at: number|null, tokens: Tokens, usd: number|null, key: string|null}`. Callers count each non-null `key` once per file.
- `ompUsage`: `type:"message"` with `message.role === "assistant"` and an object `message.usage`, or `type:"model_usage"` with `usage`. `usd = usage.cost.total ?? null`. `at` = `Date.parse(record.timestamp)` for a string, else `message.timestamp` when a number.
- `claudeUsage`: `type:"assistant"` with `message.usage`, sidechain records included (review fix: Claude Code 2.1.311 writes subagent replies only to `<session>/subagents/agent-<id>.jsonl`, so skipping `isSidechain` dropped subagent spend). `key = message.id ?? null`. `cacheWrite1h = cache_creation.ephemeral_1h_input_tokens ?? 0`; `cacheWrite = cache_creation.ephemeral_5m_input_tokens ?? cache_creation_input_tokens`. Side calls listed only in `cost-state` records (e.g. small-model helpers, ~0.3% of a session) are not counted.
- `codexTotal`: `type:"event_msg"`, `payload.type === "token_count"` → `input = input_tokens − cached_input_tokens`, `cacheRead = cached_input_tokens`, `output = output_tokens`.
- `Report = {today: Sum, week: Sum, days: ({date} & Sum)[7], byTool: {omp: Sum, claude: Sum, codex: Sum}, byModel: ({model} & Sum)[], unpriced: {model, tokens}[]}`. `Sum = {usd, tokens}`; `tokens` is the sum of all five fields. The week is Monday to Sunday local, holding `now`; entries with `at === null` are left out.
- Seed rows of `RATES`, taken from OMP's own cost fields on this Mac: `"claude-opus-5-5": {input:4, output:20, cacheRead:0.2, cacheWrite:5, cacheWrite1h:8}` and `"gpt-6.2-astra": {input:8, output:40}`. The `cacheWrite: 5` value is [INFERENCE]. T13 completes the table. Tests always pass their own `rates`.

```js
const R = {"claude-opus-5":{input:1,output:1,cacheRead:1,cacheWrite:1},"claude-opus-5-5":{input:4,output:20,cacheRead:0.2,cacheWrite:5,cacheWrite1h:8}};
rateFor("claude-opus-5-5-20261001",R) // → R["claude-opus-5-5"]          rateFor("mystery",R) // → null
cost({input:4,output:659,cacheRead:0,cacheWrite:0,cacheWrite1h:139830},R["claude-opus-5-5"]) // ≈ 1.131836 (within 1e-9)
ompUsage({type:"model_usage",timestamp:"2026-11-18T06:09:11.820Z",model:"claude-opus-5-5",usage:{input:1055,output:32,cacheRead:139830,cacheWrite:0,cost:{total:0.032826}}})
// → {tool:"omp",model:"claude-opus-5-5",at:Date.parse("2026-11-18T06:09:11.820Z"),tokens:{input:1055,output:32,cacheRead:139830,cacheWrite:0,cacheWrite1h:0},usd:0.032826,key:null}
price(claudeUsage({type:"assistant",timestamp:"2026-11-17T01:00:00.000Z",message:{id:"msg_1",model:"claude-opus-5-5",usage:{input_tokens:2,output_tokens:293,cache_read_input_tokens:13157,cache_creation_input_tokens:26058,cache_creation:{ephemeral_1h_input_tokens:26058,ephemeral_5m_input_tokens:0}}}}),R)
// → key "msg_1", tokens {input:2,output:293,cacheRead:13157,cacheWrite:0,cacheWrite1h:26058}, usd ≈ 0.2169634
codexTotal({type:"event_msg",payload:{type:"token_count",info:{total_token_usage:{input_tokens:1000,cached_input_tokens:400,output_tokens:50}}}}) // → {input:600,output:50,cacheRead:400,cacheWrite:0,cacheWrite1h:0}
```

## routine-file.js

```js
export const TRIGGERS: {[word: string]: string[]}   // review→[review_requested] approved changes→[changes_requested] opened→[pr_opened] merged ci-failed→[ci_failed] ci-passed→[ci_passed]
export function frontMatter(text: string): {fields: [string, string][], body: string}
export function setField(text: string, key: string, value: string): string   // review fix: in place — sets the key's last line (spelling and colon spacing kept), "" removes every line with the key, a new key goes before the closing `---` with the file's line ending; comments, blanks, unknown keys, CRLF and the body stay byte-for-byte; multi-line values are joined onto one line
export function parseWhen(text: string): When | {error: string, detail?: string}
export function nextAfter(when: When, after: number): number|null     // cron only; strictly after; local time
export function lastDue(when: When, after: number, now: number): number|null   // last due time in (after, now], searched backward from now (no step cap)
// DST (review fix): results always keep after < t ≤ now in real time; a skipped wall-clock minute runs once at the first minute after the gap; a repeated hour runs once, at its first occurrence.
export function setsOff(when: When, event: {kind: string, title: string}): boolean
export function describeWhen(when: When | {error}, text: string): {code: string, vars: object}
export function parseRoutine(slug: string, path: string, text: string, o: {home: string}): Routine
export function slugFor(name: string, taken: string[]): string
export function newFile(o: {name: string, when: string, cwd?: string, body: string}): string
```
- `When = {kind:"manual"} | {kind:"every", secs} | {kind:"cron", crons} | {kind:"on", trigger, kinds, words}`; `crons` is opaque to callers.
- `parseWhen` errors: `when-unknown`, `when-duration` (under a minute or unparsable), `when-time`, `cron-fields`, `cron-field`, `on-unknown`, `on-unavailable` (an upstream trigger that needs cockpit: `ticket assigned live release release-ok release-moved release-failed alert error`).
- `on any` covers every kind of `TRIGGERS`.
- `describeWhen` codes: `manual every-min every-hour every-day cron daily weekdays weekends days on error`; `vars` carries `n`, `times`, `days`, `expr`, `trigger`, `words`, `error`.
- `Routine = {slug, path, name, whenText, when, run: "agent"|"shell", agent, body, cwd, model, tools: string[], mode, budget: number|null, timeout, notify: "always"|"failed"|"never", paused, worktree, catchUp}`. Defaults: `timeout` 30 (minutes), `catchUp` 720 (minutes). `cwd` has a leading `~` replaced by `home`. Field parsing follows upstream `Routine::parse`.
- `slugFor`: up to 6 words split on `/[^\p{L}\p{N}]+/u`, lower-cased, joined with `-`; no words → `routine`; taken → `-2`, `-3`, …

```js
nextAfter(parseWhen("daily 09:00"),L(2026,10,29,8,59)) // → L(2026,10,29,9,0);  after L(2026,10,29,9,0) → L(2026,10,30,9,0)
nextAfter(parseWhen("weekdays 9:00, 17:30"),L(2026,10,30,18,0)) // → L(2026,11,2,9,0)    nextAfter(parseWhen("cron */15 9-17 * * 1-5"),L(2026,10,29,17,50)) // → L(2026,10,30,9,0)
nextAfter(parseWhen("cron 30 6 13 * 5"),L(2026,10,29,12,0)) // → L(2026,10,30,6,30)      nextAfter(parseWhen("every 30m"),L(2026,10,29,12,0)) // → null
lastDue(parseWhen("daily 09:00"),L(2026,10,27,10,0),L(2026,10,29,12,0)) // → L(2026,10,29,9,0);  with after L(2026,10,29,9,0) → null
parseWhen("every 10s") // → {error:"when-duration",…}   parseWhen("cron 0 9 * *") // → {error:"cron-fields"}   parseWhen("on alert") // → {error:"on-unavailable",…}   parseWhen("") // → {kind:"manual"}
setField("---\nname: x\nwhen: hourly\n---\n\nDo it.\n","paused","true") // → "---\nname: x\nwhen: hourly\npaused: true\n---\n\nDo it.\n";  setField("Do it.","when","hourly") → "---\nwhen: hourly\n---\n\nDo it.\n"
const r = parseRoutine("morning-sweep","/r/morning-sweep.md","---\nname: Morning sweep\nwhen: weekdays 09:00\ncwd: ~/work\ntools: Read, Bash(gh pr list:*)\nmodel: sonnet\nbudget: $0.50/week\nnotify: failed\n---\n\nSum up my PRs.\n",{home:"/Users/u"});
// r.name "Morning sweep", r.body "Sum up my PRs.", r.cwd "/Users/u/work", r.tools ["Read","Bash(gh pr list:*)"], r.budget 0.5, r.timeout 30, r.notify "failed", r.run "agent", r.catchUp 720
slugFor("Sum up my PRs!",[]) // → "sum-up-my-prs";  with taken ["sum-up-my-prs"] → "sum-up-my-prs-2"
```

## routine-sched.js

```js
export const TICK_MS = 15000, ON_TIME_MS = 120000, KEEP_RUNS = 20, EVENT_GAP_MS = 1200000, KILL_AFTER_MS = 10000, WEEK_MS = 604800000, LEASE_MS = 3 * TICK_MS  // EVENT_GAP_MS > gh MAX_BACKOFF_MS (15 min) + margin; marks[slug].events keys are "<kind> <PR url>" (review fix)
export function emptyState(): State
export function round(state, routines: Routine[], now, o?: {events?: GhEvent[], finished?: Finished[], maxParallel?: number, owner?: string, hold?: boolean}): Round  // owner: this scheduler instance's random token (review fix r4); a finished entry with `id` ends only that run; hold: records finished entries and starts nothing (queued jobs wait)
export function runNow(state, slug): {state, ok: boolean}                 // ok false when it runs or waits already
export function requestStop(state, slug, now): {state, stop: Stop|null}  // marks the run `stopping` only; the leader's next round emits the stop
export function started(state, slug, info: {address: string, worktree?: object}): State
export function startFailed(state, slug, now, error: string): State      // running → a record {ok:false, code:null, summary:"", error}
export function forget(state, slug, now?): State                         // a running run stays as `forgotten` + `stopping`; its finish leaves no record, only `drop`
export function lead(state, owner, now): {state, ok: boolean}           // review fix: takes or renews leader {owner, until: now + LEASE_MS}; ok false while another owner's lease is unexpired; taking over stores leaderBefore {owner, until}
export function resign(state, owner): State
export function offerEvents(state, events, now): State                  // review fix: non-leaders park GitHub events in pendingEvents (one per kind+key within EVENT_GAP_MS, at most MAX_PENDING_EVENTS = 100); round consumes them before o.events and deletes the list
export function spentWeek(state, slug, now): number
export function nextRuns(routine, state, now, n = 3): number[]
export function normalizeState(raw): State  // review fix r5: complete state whose slug tables have no prototype
```
- `State = {version: 1, ticked?: number, tickedBy?: string, leader?: {owner, until}, marks: {[slug]: {seen, fired, over?, events?}}, running: {[slug]: Running}, queued: Queued[], runs: {[slug]: Record[]}, costs: {[slug]: {at, usd}[]}}`. `costs` (review fix, additive) keeps 7 days of run costs per routine, separate from the 20 displayed `runs`; the weekly budget reads it. A state without `costs` rebuilds it from its records; `emptyState()` returns `costs: {}`. `ticked` (review fix r3) is the time of the last round and `tickedBy` (r4) the owner token of the instance that ran it; a round trusts `ticked` only when `tickedBy === o.owner`, so the first round of every instance counts as a restart.
- Lease safety (review fix): every tick first commits `lead(s, owner, Date.now())`; collection and rounds run only after it, and `holdsLease` uses the current clock with a 5 s margin. Right before each launch, and again after `makeWorktree`, a `confirmClaim` op renews the lease and checks the exact claim (id, owner, no address, not stopping); otherwise the launch is skipped and its worktree removed. A recorded run that is still running is stopped through its receipt and kept (files kept, worktree settled when it ends). An address-less claim is not marked `lost` while its owner is the leader, or is `leaderBefore` within `until + LEASE_MS`.
- Leader lease (review fix): only the instance holding `leader` runs rounds, launches, stops and cleans up; each tick commits `lead + round` as one CAS op, so a lost lease makes the round a no-op. Other instances only read and display, and commit user actions (`runNow`, `requestStop`, `forget`) as ops that the leader carries out (it re-ticks within 2 s of a state-file change). `stopService` resigns. A stopping run not yet signalled gets one `stop` (`signalled: true`), then a kill after `KILL_AFTER_MS`; timeouts set `signalled` too. Launch receipts stay in instance memory until a commit settles them: exact claim → attach; claim gone but id in history → completed (files kept, late worktree settled); otherwise orphan (stopped, its own files deleted). Run folders are removed only when empty (`rmdir`).
- Operation replay (review fix, replaces the earlier union merge): every exported function is an operation `state → state`. `sys/routines.js` `commitOp(op)` reads the state file, applies `op`, and compare-and-writes; on a conflict it reads again and re-applies the same op (≤ 5 tries), never merges. A refused write on an unchanged file is a write error: the round fails (no launch, stop or delete); after 3 failures in a row the `routines` store gets `error: {code: "state-write", detail}` plus one toast. The tick round is recomputed on the fresh state, and a start launches only when the committed state still has `running[slug].id === start.id`, `owner === mine` and no address. `why.at` is the occurrence key: an occurrence already queued, running or recorded is never claimed again, whoever owns it.
- Slug tables (`marks`, `running`, `runs`, `costs`, `marks[slug].events`) are prototype-free (`normalizeState`), so slugs such as `constructor` or `__proto__` are plain keys.
- `Running = {id, started, why, event, timeout, owner?, late?, retry?, stopping?, timedOut?, address?, worktree?}`; `id = String(now)` without an owner, `` `${now}-${owner.slice(0,6)}` `` with one (owner tokens are 12 random base36 characters); `owner` = the claiming instance's token.
- `Why = {kind: "schedule"|"interval"|"event"|"manual", at?: number, late?: boolean, title?: string}`. Interval jobs and records carry `at` (on time too). Event prompts carry only the validated event kind and the PR (`owner/repo#n` and URL matching `^https://github.com/<owner>/<repo>/pull/<n>$`), never the title, and say that any GitHub text the agent reads is untrusted data; the routine body decides what to fetch.
- `Finished = {slug, code: number|null, text?: string, usd?: number|null, session?: string|null, isError?: boolean, worktree?: object}`. `sys/routines.js` builds it when `<base>.exit` exists or the run's terminal is gone.
- `Record = {id, started, ended, ok, code, why, summary, cost?, session?, late?, missed?, stopped?, timedOut?, worktree?, error?}`. `ok = code === 0 && !isError && !stopping`. `summary` is the first non-empty line of `text`, at most 160 characters.
- `Round = {state, start: {slug, id, why, event}[], stop: {slug, id, kill: boolean}[], notify: {slug, kind: "ok"|"failed"|"missed"|"over-budget", name, summary}[], drop: {slug, id}[]}`. `drop` lists runs pushed out of the newest 20, whose files the caller deletes.
- Round order: apply `finished`; mark new routines `seen = now`; schedule; listen to `events`; start queued while fewer than `maxParallel` (default 3) run; time out.
- Schedule: the base is `max(seen, fired)`; the latest due time is found backward from `now` (no step cap). A due time is on time when the previous round (`ticked`) came before it and at most `ON_TIME_MS` before `now` (the scheduler kept running). Otherwise (restart, stopped, paused, first round) the routine's catch-up window applies exactly (`never` = 0): within it → one queued run, `late: true` when over 2 min; later → one `missed` record. `every` routines use the same rule with due times `base + k·step`.
- Paused routines and routines whose `when` is an error never queue; a scheduled or event job queued before the pause is dropped without a record when its turn comes; a manual job still starts. A routine marked `unavailable: true` (its file exists but can't be read) neither schedules nor starts and keeps its queued jobs until a read shows the file gone; an unlistable routines folder skips the round entirely.
- A routine with `budget` and `spentWeek ≥ budget − 0.01` drops its queued run and emits `over-budget` once.

```js
const R = (text) => parseRoutine("r","/r/r.md",text,{home:"/h"}), S = (seen) => ({...emptyState(),marks:{r:{seen,fired:0}}});
let a = round(S(L(2026,10,27,10,0)),[R("---\nwhen: daily 09:00\n---\nx")],L(2026,10,29,12,0));
// a.start → [{slug:"r",id:String(L(2026,10,29,12,0)),why:{kind:"schedule",at:L(2026,10,29,9,0),late:true},event:null}]; a.state.marks.r.fired → L(2026,10,29,9,0); a round 15 s later starts nothing
let b = round(S(L(2026,10,27,10,0)),[R("---\nwhen: daily 09:00\ncatch-up: 60\n---\nx")],L(2026,10,29,12,0));
// b.start → []; b.state.runs.r[0] → {id:String(L(2026,10,29,9,0)),started:L(2026,10,29,9,0),ended:L(2026,10,29,9,0),ok:false,missed:true,code:null,why:{kind:"schedule",at:L(2026,10,29,9,0)},summary:""}; b.notify[0].kind → "missed"
round(S(1000),[R("---\nwhen: every 30m\n---\nx")],1000+1799999).start // → [];  at 1000+1800000 → one start with why {kind:"interval"}
// timeout: running.r = {id:"1",started:0,timeout:30,…}; round(…, 30*60000+1).stop → [{slug:"r",id:"1",kill:false}]; a round KILL_AFTER_MS+1 later without finished → [{…,kill:true}]
```

## agent-cmd.js

```js
export function adapterOf(command: string[]): "omp"|"claude"|"codex"|null         // basename of command[0]
export function headlessArgv(command: string[], prompt: string, o?: {model?: string, edits?: boolean, sessionDir?: string, readOnly?: boolean}): string[]|null   // null only with readOnly when the command can't enforce it
export function canReadOnly(command: string[]): boolean                           // review fix: false for `{prompt}` templates and unknown programs
export function forkArgv(tool, base: string[], session: string): string[]         // base from resume-tools.baseArgv
export function parseOutput(tool: string|null, r: {out: string, err: string, code: number|null}): {text: string, usd: number|null, session: string|null, isError: boolean}
export function summaryLine(text: string, max = 160): string                       // first non-empty line, leading "#" and spaces cut
export function routinePrompt(routine, o: {why: string, at: string}): string
```
- A command element containing `{prompt}` is filled and nothing is appended. Otherwise the adapter's form applies; an unknown command gets the prompt as its last word.
- Claude: `parseOutput` reads the last JSON line with `type:"result"` (`result`, `total_cost_usd`, `session_id`, `is_error`).
- Others: `text` = trimmed `out`, else trimmed `err`; `usd: null`; `isError = code !== 0`.
- `routinePrompt` = `<body>\n\n---\nlazuli runs this as the routine "<name>" (<whenText>): <why>, at <at>. Nobody is watching: do what it asks without waiting for answers, then reply with what you did or found, its first line a one-line summary.` The caller appends `promptLanguageLine()`.
- `readOnly` (review fix; Inbox plan, Recap, Review walkthrough): only the executable of `command` is kept (extra words such as `--yolo` would undo it) and `edits` is ignored. omp → `-p --tools=read,grep,glob --approval-mode=always-ask` (print mode refuses every write/exec-tier call, MCP included); claude → `--permission-mode plan --tools Read,Grep,Glob --allowedTools Read,Grep,Glob --strict-mcp-config`; codex → `exec --skip-git-repo-check --ignore-user-config --ignore-rules --sandbox read-only`. `aiRun({readOnly:true})` resolves `{ok:false, error:"read-only-unsupported"}` without running when `headlessArgv` returns null. Prompts still mark PR/review/CI text as untrusted data.

```js
headlessArgv(["omp"],"hi",{sessionDir:"/r/s"}) // → ["omp","-p","--session-dir","/r/s","--","hi"]
headlessArgv(["claude"],"hi",{model:"sonnet",edits:true}) // → ["claude","-p","hi","--output-format","stream-json","--verbose","--model","sonnet","--permission-mode","acceptEdits"]
headlessArgv(["codex"],"hi",{edits:true}) // → ["codex","exec","--skip-git-repo-check","--sandbox","workspace-write","hi"]     headlessArgv(["my-agent","--ask","{prompt}"],"hi") // → ["my-agent","--ask","hi"]
forkArgv("claude",["claude"],"S") // → ["claude","--resume","S","--fork-session"]   forkArgv("codex",["codex","-m","x"],"S") // → ["codex","fork","-m","x","S"]   forkArgv("omp",["omp"],"/a.jsonl") // → ["omp","--fork","/a.jsonl"]
parseOutput("claude",{out:'{"type":"system","subtype":"init"}\n{"type":"result","is_error":false,"result":"Done.\\nDetails","total_cost_usd":0.12,"session_id":"s1"}\n',err:"",code:0}) // → {text:"Done.\nDetails",usd:0.12,session:"s1",isError:false}
```

## resume-tools.js

A port of `mods/lstack-herdr/components/lh-resume-tools.js` with the same bodies, plus:
```js
export const LABEL = "lazuli.resume", OLD_LABEL = "lstack-herdr.resume", SENT_WAIT_MS = 30000
export const TOOLS; export function toolOf(t); export function baseArgv(tool, argv); export function resumeArgv(tool, base, session)
export function sessionFrom(tool, stdout); export const quote; export function shellLine(argv, cd = null)
export function encodeRecord(r): string    // {tool, session, argv, cwd, pid, tried: {pid, at, failed}|null}
export function decodeRecord(text): Record|null   // null unless tool known, session and argv non-empty, pid an integer
export function restoreStatus(t, record: Record|null, now): null | "pending" | "sent" | "failed"
```
`restoreStatus`:
- `null` when there is no record, `toolOf(t)` is set, or `t.pid === record.pid`.
- With `record.tried?.pid === t.pid`: `"failed"` when `tried.failed` or `now − tried.at ≥ SENT_WAIT_MS`, else `"sent"`.
- Otherwise `"pending"`.

```js
baseArgv("claude",["claude","--model","opus","--resume","abc","fix it"]) // → ["claude","--model","opus"]        baseArgv("claude",["claude","-p","hi"]) // → null
baseArgv("codex",["codex","resume","-m","gpt-5","0199"]) // → ["codex","-m","gpt-5"];  resumeArgv("codex",["codex","-m","gpt-5"],"S") // → ["codex","resume","-m","gpt-5","S"]
shellLine(["omp","--resume","/a b/s.jsonl"],"/w") // → "cd /w && omp --resume '/a b/s.jsonl'"
sessionFrom("codex","/x/rollout-2026-11-09T15-51-59-01a1bf13-f7f2-75f1-866c-70931d67a6d4.jsonl\n") // → "01a1bf13-f7f2-75f1-866c-70931d67a6d4"
restoreStatus({pid:9,foreground:{pid:9}},{tool:"omp",session:"/s.jsonl",argv:["omp"],cwd:null,pid:5,tried:{pid:9,at:1000,failed:false}},31000) // → "failed"; at now 2000 → "sent"; with tried:null → "pending"
```

## migrate-plan.js

```js
export function pinsFrom(config: object|null): string[]|null      // .spaces names (strings or {name}) kept if in inbox|todo|routines; .spaces absent or not an array → null (lazuli defaults); a valid list with none kept → [] (review fix: plan emits {op:"pins", pins:[]})
export function queueFrom(doc: object|null): QueueDoc              // "app:<addr>" → "<addr>"; other handles dropped
export function plan(i: Input): {steps: Step[], counts: {todo, routines, pins, queue, labels, cache}}
```
- `Input = {done: boolean, now, home, appHome, todo: {exists, targetExists}, routines: {names: string[], existing: string[]}, config: object|null, queue: {doc: object|null, targetExists}, terminals: {address: string, labels: object}[], cacheExists: boolean, pendingMachines: string[]}`.
- `Step` is one of `{op:"copy", from, to}`, `{op:"write-json", to, value}`, `{op:"pins", pins}`, `{op:"label", address, key, value, clear}`, `{op:"rm", path}`, `{op:"marker", to, value}`.
- Order: to-do, routines (sorted names; dot files and existing targets skipped), pins, queue (only when it has items and the target is absent), labels, rm, marker.
- Paths: `<home>/.config/cockpit/…` → `<appHome>/data/lazuli/…`; rm path is exactly `<home>/.cache/lstack-herdr`.
- Marker value: `{version: 1, at: now, counts, pendingMachines}`.
- `done: true` → `{steps: [], counts: all 0}`. No value from `config` other than the pin names appears anywhere in the plan.

```js
pinsFrom({spaces:["inbox","terminal","todo",{name:"notes"},"meetings","routines"],token:"sekret"}) // → ["inbox","todo","routines"]     pinsFrom({}) // → null
queueFrom({version:1,queues:{"app:t3":[{id:"q1-0",text:"a",at:1}],"w1:p2":[{id:"q2-0",text:"b",at:2}]}}) // → {version:1,queues:{t3:[{id:"q1-0",text:"a",at:1}]}}
plan({done:false,now:5,home:"/h",appHome:"/h/.config/herdr-app",todo:{exists:true,targetExists:false},routines:{names:[],existing:[]},config:null,queue:{doc:null,targetExists:false},terminals:[{address:"t2",labels:{"lstack-herdr.resume":"X"}}],cacheExists:true,pendingMachines:[]}).steps
// → [{op:"copy",from:"/h/.config/cockpit/todo.md",to:"/h/.config/herdr-app/data/lazuli/todo.md"},{op:"label",address:"t2",key:"lazuli.resume",value:"X",clear:"lstack-herdr.resume"},{op:"rm",path:"/h/.cache/lstack-herdr"},{op:"marker",to:"/h/.config/herdr-app/data/lazuli/migrated.json",value:{version:1,at:5,counts:{todo:1,routines:0,pins:0,queue:0,labels:1,cache:1},pendingMachines:[]}}]
```

## paths.js

```js
export const MAX_EDIT = 400000
export function kindOf(name: string): "md"|"html"|"pdf"|"svg"|"image"|"text"   // by extension, case-insensitive
export function modesFor(kind, o?: {remote?: boolean}): ("edit"|"split"|"preview")[]
export function defaultMode(kind, o?): string|null
export function nextMode(kind, mode, o?): string|null       // Edit → Split → Preview → Edit over the available modes
export function normalize(path: string): string              // resolves "." and "..", collapses "//", no trailing "/"
export function fileKey(file: string, on?: string|null): string   // (on ?? "") + ":" + normalize(file)
export function basename(path): string; export function dirname(path): string
export function tilde(path: string, home: string): string
export function tabName(file: string, o: {preview: boolean, dirty: boolean}): string
export function invalidName(name: string, siblings: string[]): null | "empty"|"dots"|"slash"|"taken"
export function editability(o: {text: string, writable: boolean, on?: string|null}): {readOnly: boolean, reason: null|"remote"|"too-large"|"nul"|"not-writable", text: string}
```
- Extensions: `md markdown` → md; `html htm` → html; `pdf`; `svg`; `png jpg jpeg gif webp` → image; anything else → text.
- Remote: md and text keep their modes; html and svg → `["edit"]`; pdf and image → `[]` (info card).
- `editability` reasons are checked in the order listed in the type; `too-large` cuts `text` to `MAX_EDIT` characters.
- A file that cannot be read as text is "binary" for the caller (`file/model.js`), not for `kindOf`.

```js
kindOf("README.MD") // → "md"   kindOf("a.tar.gz") // → "text"   modesFor("pdf") // → ["preview"]   modesFor("html",{remote:true}) // → ["edit"]   defaultMode("md") // → "split"   defaultMode("html") // → "preview"
nextMode("md","preview") // → "edit"   nextMode("text","edit") // → "edit"   fileKey("/a/b/../c.md",null) // → ":/a/c.md"   fileKey("/a/c.md","vps") // → "vps:/a/c.md"
tabName("/a/c.md",{preview:true,dirty:false}) // → "◦ c.md";  dirty:true → "● c.md";  both false → "c.md"
invalidName("a/b",[]) // → "slash"   invalidName("..",[]) // → "dots"   invalidName(" ",[]) // → "empty"   invalidName("x",["x"]) // → "taken"   invalidName("ok.md",["x"]) // → null
```

## tabs-reg.js

```js
export function findOpen(reg, q: {file, on, space}): string|null          // fid with the same fileKey in that space
export function previewOf(reg, space: string): string|null
export function openPlan(reg, q: {file, on, space, pin: boolean, fid: string, now: number, dirty?: string[]}): Plan
export function pin(reg, fid): Reg; export function setMode(reg, fid, mode): Reg
export function bind(reg, fid, ids: {space, tab, pane}): Reg
export function claim(reg, fid, tabs: string[]): string|null               // first tab no other fid holds
export function sweep(reg, liveTabs: string[], misses: {[fid]: number}, now): {reg, misses}
```
- `Reg = {[fid]: {file, on, preview, mode, space, tab, pane, at}}`, the value of `shared("lazuli.tabs")`.
- `Plan` is one of:
  - `{action: "select", fid}` when the file is open in that space.
  - `{action: "retarget", fid, reg, name}` when `pin` is false and the space has a preview tab that is not in `dirty`.
  - `{action: "new", fid, reg, name, props: {view: "file", fid, file, on, preview}}`.
- New and retargeted entries get `mode: null` (the kind's default) and `at: now`.
- `sweep`: an entry whose `tab` is not live gets one more miss and is removed at 2. An entry with `tab: null` is removed once `now − at > 60000`. A live entry's miss count resets.

```js
const reg = {p1:{file:"/a/x.md",on:null,preview:true,mode:null,space:"s1",tab:"T1",pane:"P1",at:1}};
openPlan(reg,{file:"/a/./x.md",on:null,space:"s1",pin:false,fid:"n",now:9}) // → {action:"select",fid:"p1"}
openPlan(reg,{file:"/a/y.md",on:null,space:"s1",pin:false,fid:"n",now:9}) // → {action:"retarget",fid:"p1",name:"◦ y.md",reg:{p1:{...reg.p1,file:"/a/y.md",at:9}}};  with dirty:["p1"] or pin:true → action "new"
openPlan(reg,{file:"/a/y.md",on:null,space:"s2",pin:true,fid:"n",now:9}).props // → {view:"file",fid:"n",file:"/a/y.md",on:null,preview:false}
sweep(reg,[],{},9) // → {reg, misses:{p1:1}};  sweep(reg,[],{p1:1},9) // → {reg:{}, misses:{}}
```

## drafts.js

```js
export const DRAFT_EVERY_MS = 1000
export function draftFile(dir: string, keyHash: string): string            // `${dir}/${keyHash}.json`
export function makeDraft(o: {file, on, baseHash, text, now}): Draft       // {version: 1, file, on, baseHash, text, at}
export function parseDraft(json: string|null): Draft|null
export function shouldWrite(o: {dirty: boolean, text: string, lastText: string|null, lastAt: number, now: number}): boolean
export function decide(draft: Draft|null, disk: {file, on, text: string, hash: string}): {banner: boolean, remove: boolean, baseChanged: boolean}
```
`decide`: no draft, or a draft for another `fileKey` → all false. Draft text equal to disk text → `remove: true`. Otherwise `banner: true` with `baseChanged = draft.baseHash !== disk.hash`.

```js
const d = makeDraft({file:"/a/x.md",on:null,baseHash:"h1",text:"new",now:5}); // → {version:1,file:"/a/x.md",on:null,baseHash:"h1",text:"new",at:5}
decide(d,{file:"/a/x.md",on:null,text:"old",hash:"h1"}) // → {banner:true,remove:false,baseChanged:false};  with hash "h2" → baseChanged:true;  with text "new" → {banner:false,remove:true,baseChanged:false}
shouldWrite({dirty:true,text:"a",lastText:"a",lastAt:0,now:5000}) // → false;  lastText:"b", lastAt:4500 → false;  lastText:"b", lastAt:4000 → true
parseDraft("{bad") // → null
```

## fuzzy.js

```js
export function score(query: string, path: string): number|null   // null unless query is a case-insensitive subsequence
export function rank(query: string, paths: string[], limit = 50): {path: string, score: number, positions: number[]}[]
```
- Higher is better. Tests assert order, never numbers.
- Guarantees: an exact basename beats a basename prefix; a prefix beats another match inside the basename; that beats a match that needs the folder part; contiguous beats scattered.
- Ties: shorter path, then code-unit order.
- Empty query → the first `limit` paths in input order, score 0.

```js
rank("main",["src/domain/index.js","src/main.js","main.js"]).map((r) => r.path) // → ["main.js","src/main.js","src/domain/index.js"]
rank("xyz",["a.js"]) // → []      score("MD","docs/README.md") !== null // → true      rank("",["b","a"]).map((r) => r.path) // → ["b","a"]
```

## md-tree.js

```js
export function parse(text: string): Block[]            // toTree(lexer(text)) with the vendored marked (gfm)
export function toTree(tokens: object[]): Block[]
export function blockKey(raw: string): string            // djb2 of the token's raw text, hex
export function slug(text: string): string               // lower-case; spaces → "-"; drops all but letters, digits, "-", "_"
export function resolveLink(href: string, baseDir: string): {kind: "url", url} | {kind: "file", path, anchor: string|null} | {kind: "anchor", anchor} | {kind: "other"}
```
- Every block has `key`. Types:
  - `heading {depth, id, inlines}`
  - `paragraph {inlines}`
  - `list {ordered, start: number|null, items: {task, checked, blocks}[]}`
  - `blockquote {blocks}`
  - `code {lang: string|null, text}`
  - `table {align: (string|null)[], header: Inline[][], rows: Inline[][][]}`
  - `hr {}`
  - `html {text}`
- `Inline` is `{type:"text", text, bold?, italic?, strike?, code?}`, `{type:"link", href, title, inlines}`, `{type:"image", src, alt, title}` or `{type:"br"}`. Style flags appear only when true. `space` tokens are dropped.
- `resolveLink`: `http(s)` → url; `#x` → anchor; another scheme → other; anything else → file, normalized against `baseDir`.

```js
parse("# Hi **you**\n\nSee [docs](./a.md).\n\n```js\nlet a\n```\n").map(({key, ...b}) => b)
// → [{type:"heading",depth:1,id:"hi-you",inlines:[{type:"text",text:"Hi "},{type:"text",text:"you",bold:true}]},
//    {type:"paragraph",inlines:[{type:"text",text:"See "},{type:"link",href:"./a.md",title:null,inlines:[{type:"text",text:"docs"}]},{type:"text",text:"."}]},
//    {type:"code",lang:"js",text:"let a"}]
resolveLink("./b/c.md#x","/a") // → {kind:"file",path:"/a/b/c.md",anchor:"x"}   resolveLink("#top","/a") // → {kind:"anchor",anchor:"top"}   resolveLink("mailto:x@y","/a") // → {kind:"other"}
```

## lru.js

```js
export function total(entries: {size: number}[]): number
export function evict(entries: {name: string, size: number, used: number}[], cap: number): string[]   // names to delete: oldest `used` first, ties by name, until total ≤ cap
```
```js
evict([{name:"a",size:60,used:1},{name:"b",size:60,used:3},{name:"c",size:60,used:2}],100) // → ["a","c"];  cap 200 → [];  evict([{name:"x",size:500,used:9}],100) // → ["x"]
```

## proto.js

```js
export const MAX_LINE = 1048576
export function utf8Decode(bytes: Uint8Array): string
export function createFramer(max = MAX_LINE): {push(bytes: Uint8Array): {lines: string[], error: null|"line-too-long"}}
export function encode(msg: object): string                                   // JSON.stringify(msg) + "\n"
export function parseReply(line: string): {id, ok: true, value: object} | {id, ok: false, error: {code, message}} | {event: string, value: object} | {bad: true}
export const PDF_OPS: {[op: string]: string[]}   // hello:[token] open:[path] render:[doc,page,width] search:[doc,query] links:[doc,page] outline:[doc] text:[doc,page] close:[doc] ping:[]
export function checkRequest(msg: object): null | "bad-op" | "missing-field"
```
- The framer holds an unfinished line, also across a split multi-byte character. After an error every later `push` returns the same error.
- `value` is the reply without `id`, `error` and `event`.

```js
const B = (s) => new TextEncoder().encode(s), f = createFramer();
f.push(B('{"id":1,"pa')) // → {lines:[],error:null};   f.push(B('ges":3}\n{"id":2}\n')) // → {lines:['{"id":1,"pages":3}','{"id":2}'],error:null}
// g=createFramer(): g.push(Uint8Array.of(0xED,0x95)) → no lines; g.push(Uint8Array.of(0x9C,0x0A)) → {lines:["한"],error:null};  createFramer(4).push(B("12345")) → {lines:[],error:"line-too-long"}
parseReply('{"id":7,"pages":3}') // → {id:7,ok:true,value:{pages:3}}   parseReply('{"id":7,"error":{"code":"not_found","message":"x"}}') // → {id:7,ok:false,error:{code:"not_found",message:"x"}}   parseReply("nope") // → {bad:true}
checkRequest({op:"render",doc:"d",page:1}) // → "missing-field"    checkRequest({op:"zap"}) // → "bad-op"    checkRequest({op:"ping"}) // → null
```

## CLI: `bin/scan.mjs usage` and `sessions`

Both take one optional JSON argument and print one JSON line. They use only `node:` built-ins, so they also run under the relay's Deno runner.

| Item | `usage` | `sessions` |
|---|---|---|
| argv | `node scan.mjs usage ['{"now":ms,"roots":{…},"cache":"/path","rates":{…}}']` | `node scan.mjs sessions ['{"query":"text","limit":200,"roots":{…},"cache":"/path"}']` |
| Defaults | `now` = current time; roots `~/.omp/agent/sessions`, `~/.claude/projects`, `~/.codex/sessions`; cache `~/.cache/lazuli/usage-cache.json` | same roots; cache `~/.cache/lazuli/sessions-index.json`; `limit` 200 |
| stdout | `{version:1, at, ...Report, skipped:{files, zst, unreadable}}` (`Report` of `spend.summarize`) | `{version:1, at, total, sessions:[{tool, id, path, cwd, title, first, last, model}], skipped}` |
| Order, filter | n/a | newest `last` first; `query` matches `title` or `cwd`, case-insensitive substring |
| Field notes | A `.jsonl.zst` rollout is read through `zstd -dc` when that can be spawned; otherwise counted in `skipped.zst`. Subagent files (`agent-*`, OMP child folders) are counted for spend. | `first`, `last` in ms. `id`: OMP header `id`; Claude file stem; Codex UUID from the file name. Resume takes `path` for OMP and `id` for the others. Subagent files are left out. |

Exit codes for both:
- 0: result printed. A missing root gives zero totals or an empty list.
- 2: unknown subcommand or an argument that is not a JSON object; message on stderr, stdout empty.
- 1: anything else, with stdout `{"error":"<message>"}`.

A `roots` key set to `null` skips that tool. Tests pass `roots` and `cache` pointing at fixtures and a temp file.

## CLI: `bin/run-agent.mjs`

`node run-agent.mjs <base>`, where `<base>` is an absolute path without extension: `~/.cache/lazuli/routines/<slug>/<id>` or `~/.cache/lazuli/runs/<id>`.

| File | Writer | Content |
|---|---|---|
| `<base>.cmd` | mod, before the start | `{"version":1,"argv":["…"],"cwd":"/abs","env":{"set":{"K":"V"},"unset":["K"]},"timeoutMs":1800000}` |
| `<base>.pid` | wrapper, right after spawn | `{"pid":123,"pgid":123,"started":ms}` |
| `<base>.out`, `<base>.err` | the command | raw stdout and stderr; created empty at start |
| `<base>.exit` | wrapper, once, through a temp file and rename | `{"code":0,"signal":null,"ended":ms,"timedOut":false,"error":null}` |
| `<base>.txt` | mod, after the end | the text the views show (`parseOutput(...).text`), bounded: whole up to 256 KiB, else the first 64 KiB + "\n…\n" + the last 192 KiB; written via a temp file + `mv`, never through argv |

- The command runs in its own process group with stdin from `/dev/null`.
- `PATH` gets `:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$HOME/.claude/local` appended.
- SIGTERM or SIGHUP to the wrapper, or `timeoutMs` passing, sends SIGTERM to the group and SIGKILL 10 s later. The exit file then has `code: null`, the signal name, and `timedOut` set for a timeout.
- A command that cannot start gives `code: null, error: "spawn: <reason>"`.
- Wrapper exit code: 0 whenever `<base>.exit` was written; 2 for a missing argument or an unreadable or invalid `.cmd` (it still writes `.exit` with `error` when it can).

## Node module: `bin/lib/static-server.mjs` (added by Main, 2026-11-19)

Owned by T16; used by `bin/html-view.mjs`. Plain Node (`node:http`, `node:fs/promises`, `node:path`).

```js
export async function startStaticServer(o: {
  root: string,                       // absolute folder; resolved with fs.realpath once at start
  host?: "127.0.0.1",                 // only this value is accepted
  port?: number,                      // default 0 (random free port)
  renderMarkdown?: (text: string, o: {title: string}) => string,  // default: renderPage from ./md-page.mjs
  blockNetwork?: () => boolean,       // review fix: while true, responses carry `Content-Security-Policy: connect-src 'self' http: https: data: blob:` (refuses WebSockets) and shared-worker scripts get `default-src 'self' data: blob:`
}): Promise<{ port: number, origin: string, url(rel: string): string, close(): Promise<void> }>
```

- `origin` is `http://127.0.0.1:<port>`; `url(rel)` percent-encodes each path segment of a root-relative path.
- Binds `127.0.0.1` only.

| Request | Response |
|---|---|
| `Host` header not exactly `127.0.0.1:<port>` | 403, empty body |
| method other than GET or HEAD | 405, `Allow: GET, HEAD` |
| path that, after percent-decoding and `realpath`, is outside `root` (`..`, `%2e%2e`, a symlink leading out) | 404 |
| any path segment starting with `.` (after percent-decoding, before `realpath`: `.git`, `.env`, `%2egit`), the md route included | 404 (review fix) |
| existing file under `root` | 200, file bytes, `Content-Type` from the extension (`.html` → `text/html; charset=utf-8`, `.css`, `.js`/`.mjs` → `text/javascript`, `.json`, `.svg`, `.png`, `.jpg`, `.gif`, `.webp`, `.woff2`, `.wasm`; other → `application/octet-stream`) |
| a directory, including `/` | 404 (no listing, no index fallback) |
| missing file | 404 |
| `GET /__lazuli/md/<rel>` where `<rel>` is a `.md`/`.markdown` file under `root` | 200 `text/html; charset=utf-8`, the body `renderMarkdown(fileText, {title: basename})`; any other `<rel>` → 404. The default renderer passes marked's output through `sanitizeHtml()` (`bin/lib/html-sanitize.mjs`: allowlisted elements/attributes, URLs limited to relative, http(s), `mailto:` on links and `data:image/` on images) and puts a CSP meta first in `<head>` (`default-src 'none'`, scripts only by hash plus the pinned SRI loaders, `connect-src 'none'`), so Markdown content never runs script (review fix, round 3) |
| HEAD | same status and headers as GET, no body |

- Every response carries `Cache-Control: no-store`.
- The server serves disk content only (DESIGN B7); it never caches file bytes.
- `close()` stops listening and destroys open sockets; it resolves when done.

## Unverified items

| # | Item | Who checks |
|---|---|---|
| V1 | Claude Code records carry `timestamp` and `isSidechain` at the top level; subagent records live only under `<session>/subagents/`. Checked against the 2.1.311 binary; this Mac's transcripts had no sidechain records. | T13, on one real line; FixResumeSpend |
| V2 | Codex takes its model from the latest `turn_context` record's `payload.model`; `null` when absent. | T13 |
| V3 | `omp -p` writes a session file under `--session-dir` (the CLI reference documents the flag, not print mode's persistence). If not, C4 falls back to `usd: null` for omp. | T12 |
| V4 | Codex prints its session id on stderr as `session id: <uuid>`; `parseOutput("codex")` returns `session: null` until this is confirmed. | T12 |
| V5 | The exact tail of the reference `decodeRecord` condition (cut off in my read); the contract above states the intended rule. | T13/T14, from `lh-resume-tools.js:147` |
| V6 | marked 18 token field names used by `toTree` (`strong`, `em`, `del`, `codespan`, list `task`/`checked`); the `parse` example is the acceptance check. | T15 (S7) |

## herdr-caffeinate wiring (herdr-caffeinate plan node L1; its contracts C1, C3, C9, C12; DESIGN D3)

herdr-caffeinate is a separate mod in its own repository. lazuli imports nothing from it: it reads the shared key
`herdr-caffeinate.state` (its C3) and runs that mod's `herdr-caffeinate.<command>`s (its C1). Files (its C12):
`core/caffeinate-chip.js`, `sys/caffeinate.js`, `views/status.js`, `views/shell/services.js`, `sys/search.js`,
`core/catalog/shell.{en,ko}.js`, `ui/icons/coffee.svg`, `tests/caffeinate-chip.test.mjs`. `layouts/lazuli.json` is not
changed.

### core/caffeinate-chip.js — pure

```js
export const MOD = "herdr-caffeinate"
export const STATE_KEY = "herdr-caffeinate.state"
export const HOST = {mod: MOD, props: {view: "host"}, kind: "window", frame: "none", key: "herdr-caffeinate.host", width: 2, height: 2, at: {x: 0, y: 0}}   // C9; no `keep`
export const STATUS: {[status: string]: {icon: string, tone: string}}   // starting, off, waiting, on, agent, timer, trigger
export const LID: {[status: string]: {icon: string, tone: string}}      // engaged, external, blocked, unavailable
export const BLOCKED: string[]       // "ac", "battery", "thermal", "unknown", "other-instance"
export const COMMANDS: string[]      // the C1 commands the palette may offer, in order
export function usable(state, openedAt = null): boolean
export function timeLeft(endsAt: number, now: number): {h: number, m: number} | null
export function chip(state, {openedAt = null, now = null} = {}): {status, icon, tone, active, display, left, lid, install}
export function paletteCommands(chip): string[]
export function commandKey(cmd: string): string   // "mode:on" → "mode.on"
```
- `usable`: an object with `v === 1`, a finite `at`, `mode` in off/on/agent/timer and a boolean `active`, and `at >= openedAt` when `openedAt` is a number. Anything else is `starting`: `active: false`, tone `unknown`, `lid: null`, `install: null`, `left: null`, `display: false`.
- Status: active → `trigger` (reason trigger), `timer` (mode or reason timer), `agent` (mode or reason agent), else `on`; not active → `waiting` (mode agent), else `off`. `active` is true exactly for the accent statuses (on, agent, timer, trigger). Every status uses icon `coffee`; tones: starting `unknown`, off `tertiary`, waiting `secondary`, the rest `accent`.
- `lid`: null unless `closedLid.status` is a LID key; then `{status, icon, tone, blocked}`, `blocked` a BLOCKED code for `blocked` (anything else → `unknown`), else null. Icons: engaged/external `lock` (accent/secondary), blocked/unavailable `triangle-alert` (warning). Shown whatever the mode (C10: `external` is reported with the mode Off).
- `display`: `state.display === true && state.active`. `left`: for `timer` only, `timeLeft(endsAt, now)`: whole minutes rounded up, at least 1, as `{h, m}`; null without a finite `endsAt` or `now`.
- `install`: `{sudo, failsafe}` when both are booleans, else null.
- `paletteCommands`: COMMANDS minus `timer:cancel` unless status `timer`, minus `install` unless the install is known and not both parts, minus `uninstall` unless it is known and either part is installed. Timer minutes are the plan's D1 presets (15, 60, 120); lazuli never reads herdr-caffeinate's settings.

```js
chip(null) // → {status:"starting",icon:"coffee",tone:"unknown",active:false,display:false,left:null,lid:null,install:null}
chip({v:1,at:5,mode:"timer",active:true,reason:"timer",display:true,endsAt:65*60000,closedLid:{status:"engaged",blocked:null},install:{sudo:true,failsafe:true}},{openedAt:1,now:0})
// → {status:"timer",icon:"coffee",tone:"accent",active:true,display:true,left:{h:1,m:5},lid:{status:"engaged",icon:"lock",tone:"accent",blocked:null},install:{sudo:true,failsafe:true}}
chip({v:1,at:5,mode:"on",active:true},{openedAt:6}).status // → "starting" (published before the host opened)
paletteCommands(chip(null)) // → ["menu","toggle","mode:on","mode:agent","mode:off","timer:15","timer:60","timer:120","display:toggle","closed-lid:toggle"]
```

### sys/caffeinate.js — service (the status copy's)
- `start(cx)` (from `views/shell/services.js`, after the sidecars; returns at once under `checking()`): looks for `<app home>/mods/herdr-caffeinate/mod.json` with `fs.exists` (a failure counts as absent). Absent: stops there, writing nothing and logging nothing. Present: takes the time, opens `HOST` with `openOverlay` (a copy, so the same key replaces an open host) and stores that time as `openedAt` only once `openOverlay` returned; a throw is logged, `openedAt` stays null so a host from an earlier start that still publishes is shown as it is (review fix), and the chip still shows; then marks itself present, redraws, and starts a 15 s timer that redraws when a running timer's shown minutes change. Log lines (`[lazuli/caffeinate]`, and `debug.log` area `caffeinate`) only once the mod was found.
- `stop()` (services stop): cancels the timer; the host window stays (a layout switch closes it, the next start replaces it).
- `present()`; `view(now)` → `chip(shared(STATE_KEY), {openedAt, now})`, or null when absent (safe in render); `commands(now)` → `paletteCommands(view(now))`, or `[]` when absent.

### views, palette, catalogs, icon
- `views/status.js`: after the queue item, `.when(view)` one more `item` (`st-caffeinate`): `Icon(icon)` 13 px in `toneColor(tone)`; a label in the same tone (`shell.caffeinate.label.<status>`; the timer's minutes left in the code font through `shell.caffeinate.left.{m,h,hm}`; none for starting and off); the lid mark `Icon(lid.icon)` 12 px in its tone. Tooltip and accessibility label: `tip.<status>` (`tip.timer {left}`, `tip.timerOpen` without minutes), `tip.display`, `tip.lid.<status>` (`tip.lid.blocked {reason}` with `blocked.<code>`), `tip.open`, joined with " · ". Click: `run("herdr-caffeinate.menu")`. Absent: the bar draws exactly what it drew before.
- `sys/search.js`: `caffeinateEntries(bound)` after Herdr's: `{id: "caffeinate:<cmd>", kind: "command", group: "herdr", icon: "command", title: t("shell.caffeinate.cmd.<commandKey>"), hint: "herdr-caffeinate", keys: the binding of "herdr-caffeinate.<cmd>" (for `menu` also "mod.open:herdr-caffeinate"), words: "caffeinate <cmd> awake sleep 잠자기 카페인", action: {kind: "command", run: "herdr-caffeinate.<cmd>"}}`. The group is `herdr` because palette group names live in the `palette` catalog, outside C12; the icon is `command` because `views/palette.js` draws only its own icon set.
- Catalog keys (`shell.caffeinate.*`, en and ko, "Caffeinate" English in both): `label.{on,agent,waiting,timer,trigger}`, `left.{m,h,hm}`, `tip.{starting,off,waiting,on,agent,timer,timerOpen,trigger,display,open}`, `tip.lid.{engaged,external,blocked,unavailable}`, `blocked.{ac,battery,thermal,unknown,other-instance}`, `cmd.<commandKey>` for every COMMANDS entry (titles start with "Caffeinate: ").
- `ui/icons/coffee.svg`: Lucide `coffee` at stroke width 1.75, like the rest of the set (ISC, THIRD_PARTY_NOTICES "Lucide").
- `tests/caffeinate-chip.test.mjs`: invalid, stale and `v: 2` states give `starting` with no active styling; each STATUS and LID entry has one icon (file present) and one tone, and a sample state reaches it; minutes left, lid, install and palette rules; every key above exists in both languages.

## Assistant (lazuli-assistant plan, its contracts K1–K9; DESIGN E; ARCHITECTURE §13)

Tested with Hermes Agent 0.17.0. Files: `core/acp-wire.js`, `core/assistant-agents.js`, `core/assistant-chat.js`,
`core/assistant-list.js` (pure, under the conventions above), `bin/acp-bridge.mjs`, `sys/acp-client.js`,
`sys/assistant-bridge.js`, `sys/assistant-sessions.js`, `sys/assistant.js`, `views/assistant.js`,
`views/assistant-list.js`, `views/assistant-info.js`, `views/assistant/*.js`, `core/catalog/assistant.{en,ko}.js`, eight
Lucide icons, `tests/fixtures/fake-acp-agent.mjs` with `tests/fixtures/acp/hermes-0.17.0.json`. Changed for it:
`sys/state.js`, `sys/bus.js`, `sys/store.js`, `main.js`, `core/catalog/index.js`, `views/sidebar.js`,
`views/settings.js`, `views/shell/settings-parts.js`, `views/shell/services.js`, `views/files-tree.js`,
`views/panels/files-rows.js`, `sys/notify.js`, `sys/search.js`, `views/gallery.js`, the catalogs `shell`, `settings`
and `palette`, `layouts/lazuli.json`, `keys.json`, `relay/lazuli.profile.json`.

### Wiring (K2, K7)
- `state.js`: `CENTER` ends with `"assistant"`; `COMMANDS["go:assistant"] = status`; `PREFIXED["assistant:"] = self`
  (parsed as `{name:"assistant", arg}`); `KEY.assistantUi = "lazuli.assistant.ui"`; `DEFAULT_PINS` ends with
  `"assistant"`; `SETTINGS_VERSION = 2`; settings gain `assistant: {folder: string|null, debugAgent: string[]|null}`
  (`folder`: absolute, trailing slashes dropped, else null; `debugAgent`: a non-empty array of non-empty strings as it
  is, else null: one element of another kind or an empty one makes it null, nothing is dropped from it).
  `migratedSettings(raw)` returns the normalized settings when a file below version 2 has its own `pins` array
  without `"assistant"` (that array then gains it once), else null; `store.js` writes such a file back once, through
  `writeTextFile` with the text it read as `expected`.
- `bus.js`: `go:assistant` → `showCenter("assistant")`; `assistant:<verb>` → every copy's `command("assistant:<verb>")`.
- `main.js` `VIEWS`: `assistant`, `assistant-list`, `assistant-info`. `core/catalog/index.js`: area `assistant`.
- Layout ids (ARCHITECTURE §3): `assistant`, `assistant-list`, `assistant-chat`, `assistant-side`, `assistant-info`,
  `assistant-files`; `keys.json` `"cmd-alt-4": "lazuli.go:assistant"`.
- Store `assistant` (`ASSISTANT_STORE`), always set with `snapshot: false`.

### core/acp-wire.js — pure

```js
export const PROTOCOL_VERSION = 1, DISCOVERY_VERSION = 1
export const MAX_LINE_BYTES = 16 * 1024 * 1024, MAX_WRITE_BYTES = 1048576, PING_MS = 10000, READ_TIMEOUT_MS = 30000
export const LOST_AFTER_TIMEOUTS = 3, MAX_PARALLEL_SENDS = 8, AUTH_MS = 5000, HELLO_MS = 5000
export const DISCOVERY_WAIT_MS = 45000, INIT_TIMEOUT_MS = 40000, RING_RECORDS = 4000, RING_BYTES = 8 * 1024 * 1024, IDLE_MIN = 30
export const METHOD        // initialize, session/new, session/load, session/list, session/fork, session/set_model,
                           // session/set_mode, session/prompt, session/cancel, session/update,
                           // session/request_permission, $/cancel_request
export const BYE_REASONS = ["idle", "herdr-gone", "signal", "agent-exit", "shutdown"]
export const START_ERRORS = ["agent-exit", "init-failed", "init-timeout"]
export const SEND_ERRORS = ["auth", "bad-request", "agent-gone", "too-large"]
export function request(id, method, params?), notification(method, params?), result(id, value), rpcError(id, code, message, data?)
export function initialize(id, version = "1")   // protocol 1; clientCapabilities {fs:{readTextFile:false, writeTextFile:false}, terminal:false}; clientInfo lazuli
export const sessionNew(id, cwd), sessionLoad(id, sessionId, cwd), sessionFork(id, sessionId, cwd)   // mcpServers: []
export const sessionSetModel(id, sessionId, modelId), sessionSetMode(id, sessionId, modeId), sessionPrompt(id, sessionId, prompt)
export const sessionCancel(sessionId)           // a notification
export function sessionList(id, cwd, cursor?)
export const permissionSelected(id, optionId), permissionCancelled(id)
export function createIds(nonce): {next(): string, owns(id): boolean}   // "<nonce>:<n>"; the bridge's nonce is "b"
export function fileUri(path): string | null
export function promptBlocks(text, attachments = []): Block[]   // text (when not empty), then one resource_link per absolute path or {path, name?}
export function promptText(blocks): string
export function promptPaths(blocks): string[]   // the local paths of its file:// resource_link blocks
export function classify(msg)   // {kind:"request", id, method, params, sessionId} | {kind:"update", sessionId, update, updateKind}
                                // | {kind:"notification", method, params, sessionId} | {kind:"result", id, result}
                                // | {kind:"error", id, error:{code, message, data?}} | {kind:"invalid"}
export const streamLine(token, since = null, client = null, turns = false), sendLine(token, msg), shutdownLine(token)   // `turns: true` only with since null
export function encodeLine(value): string        // JSON, every non-ASCII unit as \uXXXX, then "\n"
export function writeChunks(line, max = MAX_WRITE_BYTES): string[]
export function parseRecord(value)   // {kind:"agent", seq, at, msg} | {kind:"event", ev, …} | {kind:"reply", ok, error} | {kind:"invalid"}
export function parseDiscovery(text) // {state:"ready", pid, agentPid, port, token, profile, cwd, herdrPid, startedAt, argv} | {state:"failed", pid, code, detail} | {state:"invalid"}
export function discoveryMatches(d, {profile, cwd, herdrPid, argv}): boolean
export function createTracker(now = 0)   // fromClient(msg, t, seq), fromAgent(msg, t, seq), turnRecord(c), turnStarts(), touch(t), running(), runningSessions(), pending(), busy(), lastActivity(), idleExpired(t, idleMs), clear()
export function createStderrFilter({promptLength})   // push(text) → lines, end() → lines
export const AGENT_ERROR_MAX = 1000
export function agentErrorText(line): string | null
export function agentPath(path, home): string        // the agent's PATH: its own entries, then /opt/homebrew/bin, /usr/local/bin, ~/.local/bin, ~/.claude/local; no empty entry
export const PRE_AUTH_BYTES = 65536                  // a first line may grow past this only with its token at its head
export function leadingToken(head): string | null    // the 64-hex token a first line starts with ({"op":…,"token":…), or null
```
- A ready discovery needs a 64-hex `token`, a port in 1–65535, an absolute `cwd` and positive pids; an unknown start
  error code reads as `init-failed`; `argv` is null in a file without one. `discoveryMatches` needs the profile,
  folder, Herdr pid and the whole agent argv equal, so a file without `argv` never matches.
- Discovery pids are informational and useful for liveness checks; neither they nor `argv` authorize an OS signal.
- `parseDiscovery` preserves an optional `launchId` (32 lowercase hex digits) on ready and failed records.
- Tracker: a `session/prompt` request is running until its answer, kept with the last record seq when it went and its
  prompt blocks (`running()` → `[{id, sessionId, at, seq, prompt}]`); when a session's last prompt ends, that session's
  open agent requests end too (Hermes stops waiting after 60 s without saying so); `$/cancel_request` ends one. A
  `session/load` is open until its answer. `turnRecord(c)` is true for a session update of a session with a prompt in
  flight and no load open (a load's updates replay history); `turnStarts()` maps each running session to its oldest
  running prompt's seq. `idleExpired` is true only with nothing running, nothing pending and no message either way for
  `idleMs`.
- Stderr filter: a line `… Prompt on session <id>: <text>` keeps its prefix and becomes `[<n> chars]` (n from
  `promptLength(id)`) or `[redacted]`; the preview's own continuation lines, within its 100 characters and not
  starting a new log record, are dropped. A `conversation turn: … msg=<text>` line keeps what comes before `msg=` and
  becomes `msg=[redacted]`.
- `agentErrorText(line)`: the text of a Hermes `❌ …` line (after an optional `[…]` prefix) or of an `[ERROR]` or
  `[CRITICAL]` log record (after its time and logger name), cut to 1,000 characters with "…"; null for any other line,
  a prompt-preview or turn line included.

```js
promptBlocks("see", ["/tmp/a b.md"]) // → [{type:"text",text:"see"},{type:"resource_link",uri:"file:///tmp/a%20b.md",name:"a b.md"}]
classify({jsonrpc:"2.0",method:"session/update",params:{sessionId:"s",update:{sessionUpdate:"plan"}}}).kind // → "update"
parseDiscovery('{"version":1,"pid":7,"error":{"code":"zap"}}') // → {state:"failed",pid:7,code:"init-failed",detail:""}
```

### core/assistant-agents.js — pure

```js
export const PERMISSION_TIMEOUT_MS = 60000
export const AGENTS   // {hermes, nod}; nod = {id:"nod", name:"Nod", planned:true}
export const AGENT_IDS = ["hermes", "nod"]
export function agentOf(id), isProfileName(s)                 // ^[a-z0-9][a-z0-9_-]{0,63}$
export function agentArgv({bin | debugAgent, profile})        // [bin, "-p", profile, "acp"] or debugAgent ++ ["-p", profile, "acp"]; null for a bad name or no program
export function checkArgv({bin | debugAgent})                 // [bin, "acp", "--check"] or debugAgent ++ ["acp", "--check"]
export function stateDbPath(home, profile), profilesDir(home) // ~/.hermes/state.db for default, else ~/.hermes/profiles/<p>/state.db
export function steerReply(text, agent = "hermes")            // {code: steer-ack|steer-queued|steer-failed, vars} | null
export function parseSlash(text)                              // {name, args} | null (as Hermes reads it: lowercased, leading "/"s dropped)
export function routeText(text, agent = "hermes")             // {route:"model", model} | {route:"queue", text} | {route:"steer", text} | {route:"command", name, resync} | {route:"prompt"}
export function menuCommands(commands, agent = "hermes")      // advertised commands minus steer and queue
```
- Hermes's adapter: commands it answers itself `help model tools context reset compact steer queue version`; hidden from
  the / menu `steer queue`; reloaded after `reset compact`; buttons `allow_once allow_always deny` in that order;
  `lazuli.assistant:allow` answers `allow_once`, `:deny` answers `deny`. Steer answers are matched on the whole chunk,
  anchored at its start (`acp_adapter/server.py:1956-1973`).
- `routeText`: only a command Hermes knows routes; `/model` and `/queue` need an argument; an unknown `/word` is a
  prompt (the model's).

### core/assistant-chat.js — pure (K5)

```js
export const MAX_ITEMS = 2000, MAX_MESSAGE = 400000, MAX_TOOL_TEXT = 20000, EXPIRY_GRACE_MS = 2000, NO_REPLY = "no-reply"
export function emptyChat(key, meta = {}): ChatState
export function reduce(state, event, now): ChatState   // the same object when nothing changed
export function isRunning(state), queueHead(state), canAnswer(state, requestId, now, optionId?), approvalButtons(options, agent)
export function rows(state)   // items in order, each approval card after the item that was last when it came; tool rows carry duration

ChatState {key, profile, sessionId, agent, loaded, stale, title, updatedAt, items[], inflight{}, queue[], queuePaused,
           permissions{}, plan, commands[], models, modes, usage{context, lastTurn, stats}, lastError,
           turn: {reply, error} | null, loading, seq, dropped, unknown}
Item: user{text, attachments, via: prompt|steer|queue|replay} | assistant{text, streaming} | thought{text, streaming}
    | tool{id, title, kind, status, startedAt, endedAt, content[text|diff], locations, replayed} | notice{code, vars}
Permission {toolCallId, title, kind, content, options[{optionId, name, kind}], at, deadline, state: pending|answered|expired|cancelled}
```
Events: `update {update}` (agent and thought chunks, user chunks on replay, `tool_call`, `tool_call_update`, `plan`,
`available_commands_update`, `usage_update`, `current_mode_update`, `session_info_update`, `config_option_update`),
`permission {requestId, toolCall, options, at}`, `permission-answered {requestId, optionId}`, `prompt-sent {requestId,
kind: prompt|steer|command, text?, attachments?, via?, again?}` (`again`: only the user item, for a running turn
applied again after its history loaded), `prompt-done {requestId, stopReason, usage}`, `prompt-failed {requestId,
error}`, `queued {text}`, `unqueued {chipId}`, `queue-paused`, `queue-resumed`, `queue-flush {requestId, chipId?}`,
`load-start`, `load-aborted`, `loaded {models, modes}`, `model-set {modelId}`, `stats {stats}`, `gap`, `disconnected`, `tick`,
`agent-error {text}` (the bridge's record), `notice {code, vars?}`. Notice codes (catalog `assistant.event.<code>`):
`steer-ack`, `steer-queued`, `steer-failed`, `cancelled`, `stopped`, `failed`, `too-late`, `dropped`, `model-set`, `gap`,
`busy`.

Rules, one test each (`tests/assistant-chat.test.mjs`):
1. A chunk extends the last streaming assistant or thought item of its kind; any other item ends it.
2. `tool_call_update` replaces the fields it carries; duration = `endedAt − startedAt`, null for replayed items.
3. A permission whose `toolCallId` starts with `edit-approval-` puts its diff on the newest unfinished `edit` tool item
   with the same path.
4. `deadline = at + 60000`, `at` being the bridge's receive time; `tick` expires it; `canAnswer` at or after the deadline,
   or for a card no longer pending, is `too-late`, an unknown request or option `not-found`. When a turn ends
   (`prompt-done`, `prompt-failed`) with nothing else running, a card still pending closes as `expired` when
   `now >= deadline - EXPIRY_GRACE_MS` (the agent gave up at its own 60 s, whose clock starts a moment before the
   bridge's receive time), else as `cancelled`.
5. While a steer is not acknowledged, a chunk that is one of the adapter's steer answers becomes a notice and
   acknowledges it; it never joins an assistant message.
6. Running = any in-flight request not yet acknowledged; `queueHead` is the first chip once nothing is in flight and the
   queue is not paused.
7. `load-start` clears the items and the plan (open approval cards stay); items are `replayed` until `loaded`.
   `load-aborted` leaves the chat stale and clears `loading` without marking a partial history as loaded.
8. `gap` and `disconnected` set `stale` and end streaming.
9. At most 2,000 items (the oldest dropped behind one `dropped` notice), 400,000 characters a message, 20,000 a tool
   text; diffs are kept whole.
10. Unknown update kinds are ignored and counted.
11. A prompt sent while nothing runs starts a turn (`turn`; a steer or command does not). Assistant text, a tool item or
    a permission marks it replied (not while `loading`: a load's updates are history), and `agent-error` keeps its
    newest text (at most 2,000 characters). When it ends with `end_turn` and nothing else runs, a turn not replied adds
    `failed {detail}` with that text, or `NO_REPLY` (drawn as "Hermes ended the turn without a reply; see the bridge
    log"), and sets `lastError`. An `agent-error` that comes within 5 s after a `NO_REPLY` notice that is still the last
    item fills in its detail (stderr and stdout are separate pipes). Hermes ends a failed turn this way: `end_turn`, no
    message, the cause on stderr. `done()` clears `lastError` when the turn ends with a reply, a cancel or a stop once
    nothing in it runs, so a failed request inside it (a refused steer) no longer marks the turn failed.

`approvalButtons(options)` → `{buttons, more}`: buttons are the adapter's button ids that are present, in its order;
`more` keeps every other option in the order Hermes sent it. Never by kind: Hermes sends `allow_session` with kind
`allow_always`.

### core/assistant-list.js — pure (K6)

```js
export const SESSIONS_SQL      // Hermes 0.17.0's ACP listing (docs/spikes/S9/sessions.sql): id, title, first-user preview,
                               // cwd (model_config.$.cwd), model, message_count, started_at, last_active, token and cost columns
export function isProfileName(s), isSessionId(s)          // session: ^[0-9a-f-]{36}$
export function sessionKey(profile, sessionId), parseKey(key)   // "<profile>/<sessionId>" | null
export function normalizeCwd(p, home)                      // trimmed, ~ expanded, . and .. resolved, no trailing /
export function firmlinkShort(path)                        // "/private/tmp/x" → "/tmp/x" (any /private/… path); null otherwise
export function pathsToResolve({folder, home, profiles, local})   // the folder and every row and local cwd, normalized, each once, sorted
export function mapRows(json)       // sqlite3 -json output → [{id, title, cwd, model, messageCount, startedAt, updatedAt, stats}]; "" → []; not an array → null
export function mapSessionList(result)   // session/list → the same rows with model, count and stats unknown
export function normalizeUi(raw, folder) // {v:1, folder, selected:{agent, profile, session}|null, collapsed:[profile]}; another folder → fresh
export function buildList({folder, home, profiles, local, running, bridges, ui, real?}): ListModel
export function pruneUi(ui, list)   // the selection cleared once its group loaded without error and has no such row

ListModel = {groups:[{agent, profile, visible, collapsed, bridge, running, rows, loading, error?}],
             planned:[{agent:"nod", name:"Nod", planned:true, disabled:true}], pickable:[profile]}
row = {key, profile, sessionId, title, updatedAt, model, messageCount, running, selected, local, stats}
```
- `default` is always present and first, the rest by name; a group is visible when it is `default` or has rows in the
  folder; rows newest first; sessions made in this run (`local`) show until a stored row has them.
- A cwd is in the folder when, normalized, it is the folder's path, or when `real` (`{[normalized path]: resolved
  path}`, `""` for one that did not resolve) maps both to the same non-empty path: a session made in `/tmp/x` belongs
  to a folder kept as `/private/tmp/x`, and the other way round. Whether a short form is the same folder is the
  caller's to check, by resolving both.
- Titles as Hermes makes them: its title, else the first user message cut to 60 characters with "...", else the cwd's
  last part, else "New thread". The service passes rows and `local` with the titles it shows (K4): the agent's newest
  `session_info_update` of this run over a stored row's, and a local session's first prompt line only while it has no
  other title.

### CLI: `bin/acp-bridge.mjs` (K3)

`node acp-bridge.mjs --profile <name> --cwd <abs folder> --discovery <abs>.json --log <abs>.log --herdr-pid <pid>
--idle-min 30 --agent -- <agent argv…>`. The manager also passes `--launch-id`, `--previous`, `--legacy`,
and `--legacy-previous`; the previous values are SHA-256 fingerprints or `absent`. The standalone form expects
no previous discovery. `--inspect-discovery <current> <legacy>` reads without taking the lock and reports both
texts (`null` only on ENOENT); read errors return a nonzero exit. Non-Darwin hosts require `flock`.

| First client line (within 5 s) | Answer |
|---|---|
| `{op:"stream", token, since, client, turns?}` | `{ev:"hello", seq, bridge:{pid, agentPid, version, profile, cwd, startedAt}, agent:<initialize result>, running:[{id, sessionId, at, seq, prompt}], pending:[{id, method, sessionId, at, seq, msg}]}`, then the records after `since` (or `{ev:"gap", since, first, last}`); with `since` null and `turns: true`, instead each running session's records since its oldest running prompt went (`running[].seq`; outside its history loads; `gap` when the ring no longer holds them); then every agent line as `{seq, at, msg}` |
| `{op:"send", token, msg}` | `msg` to the agent's stdin; `{ok:true}` or `{ok:false, error:{code: bad-request\|agent-gone\|too-large}}`; close |
| `{op:"shutdown", token}` | cancel running sessions, wait up to 3 s, SIGTERM the owned agent group, SIGKILL 2 s later (5 s after a cancel) if the child has not exited, remove the discovery, `bye shutdown`, exit 0 |
| a missing, wrong or late token | `{ok:false, error:{code:"auth"}}`; close (constant-time compare) |
| 64 KiB of a first line without its token at the head (`leadingToken`) | `{ok:false, error:{code:"auth"}}` at once |

Every reply ends its connection, and the bridge destroys it 1 s later (no half-open socket is kept).

- Stream events: `ping` (after 10 s of silence), `replaced` (to the older subscriber: one stream, the newest wins),
  `{seq, at, ev:"dropped", bytes}` (an agent line over 16 MiB), `{seq, at, ev:"agent-error", text}` (after
  `initialize`, a stderr line `agentErrorText` reads; replayed like an agent line, and with the running turns' records
  to a `turns: true` stream when it came while one ran), `agent-exit {code, signal}`, `bye {reason}` with reason in
  `BYE_REASONS`. A line that is not a JSON object is skipped and logged. The replay ring keeps the last 4,000 records or
  8 MiB.
- The discovery file adds `argv`, the agent argv after `--`.
- Files and timings: ARCHITECTURE §13.1–§13.2. Exit codes: 0 after a shutdown, a signal, Herdr gone or idle; 1 when
  the agent exits or the start fails (the discovery file then holds the error); 2 for bad arguments.

### sys/ modules
- `sys/acp-client.js`: `new AcpClient({profile, discovery, nonce, valid?, onRecord, onEvent, onEnd})`; `connect(cx, since,
  {turns, ready})` → `{ok, hello}` or `{error: auth|disconnected|bridge-timeout}` (no `hello` within 5 s); `ready(hello)`
  runs before the first record is handled (a running turn's records follow its hello at once); a record below the seq
  held does not move it back. `send(cx, msg)` → `{ok}` or `{error}`; `request(cx, method, params, {timeoutMs})` →
  `{ok, result}` or `{error}` (`rpc:<code>` for a JSON-RPC error, `bridge-timeout` past the time); `nextId()`;
  `shutdown(cx)`; `close()`; `pid`, `open`, `seq`; `lastLine` (when the read loop last handled a line, pings included);
  `caughtUp(cx, ms)` (resolves once a stream opened `since` a seq has handled the bridge's replay up to its hello seq,
  or after `ms`). The read loop sleeps 1 ms after every 64 lines or 20 ms of work (Herdr's promise-job drain cap,
  ARCHITECTURE 13.3). `onEvent(ev)` gets `gap`, `dropped`, `agent-error`, `agent-exit`, `bye`; `onEnd({reason,
  detail?, bye, agentExit})` runs once when the stream ends; `shutdownBridge(cx, discovery)` stops a bridge without a
  client. `valid()` gates stream setup and ordinary writes just before sending; explicit authenticated shutdown
  can still use the departing discovery after its generation has been invalidated.
- `sys/assistant.js` (K4) bounds: `session/list` 30 s, `session/load` 45 s, `session/new`/`fork`/`set_model` 60 s. A
  stream with no line for 30 s, or an unanswered list or load, is reopened from the last record held; the load then
  tries once more after the replay (no launch); a failed list keeps the rows it had. On each `hello`, a request held in
  flight that `hello.running` does not list fails and its chat turns stale (the selected one loads again). `start(cx)`
  is a no-op on a herdr-relay device; elsewhere, after reconnecting, the chats of a profile with no bridge that still
  hold requests fail them (stale). `ensureBridge(cx, profile, {launch})`: a launch-wanting caller never gets the
  answer of a reuse-only connect in flight; it waits for it. Replacing a same-folder, same-Herdr bridge after a
  missing `hello` or an argv change requires authenticated shutdown and confirmed exit (or confirmed prior exit).
  When exit is uncertain, keep discovery and return retryable `bridge-timeout` without launching. Reuse-only never
  shuts down a bridge. Attach, recovery, callbacks and `open(cx)` are scoped to the current folder generation.
  A delayed `hello` cannot replace the active client; recovery preserves an identity mismatch as `auth`. A
  `replaced` subscriber relinquishes shutdown authority, settles its in-flight turns locally as disconnected,
  and marks its transcripts stale without sending anything to the bridge. Opening again while that instance
  may still be alive returns `disconnected` with the bridge state `off`, even if discovery is absent. Only confirmed
  PID absence clears this veto for that profile and folder; the remembered PID never authorizes a signal. An approval gets one answer
  per request id in that folder generation (a second click during the send shares the first's
  result). The folder's files are never walked twice at once.
- `sys/assistant-bridge.js`: `runtimeDir()`, `nodePath()`, `hermesPath()`, `hermesLooked()`, `folderExists(path)`,
  `herdrPid()`, `pidAlive(pid)`, `pidState(pid)` (`present`, `gone`, or `unknown` on lookup failure),
  `checkAgent(debugAgent)` → `{ok, bin}` or `{gate, detail}`. `readDiscovery(profile)` reads v2 and legacy paths via a
  Node helper; only ENOENT is `absent`, failed I/O is `unreadable`, and malformed data is `invalid`.
  `discoveredProfiles()`, `bridgeTerminals(profile, label)` (async: `hc ls --all --json --label <label>=<profile>`,
  finished terminals included, since that JSON carries no labels or pids; a live one gets its pid from `terminals()`;
  the live `terminals()` of that label when hc cannot be read), `reap(profiles)` (removes those profiles' ended bridge
  terminals; the service passes `default`, Hermes's profile folders and the listed, connected and discovered profiles
  every 60 s) and `awaitExit(cx, profile, pid)` (true only on confirmed absence). No PID-based fallback kill.
  `launch(cx, {profile, folder, herdrPid, argv, snapshot, valid})` → `{discovery, address}` for its own publication,
  or `{error, detail}`. `valid` identifies the folder generation and is checked immediately before `hc run`
  and again after awaits; `cancelLaunch(address)` uses only the address returned by that `hc run`. The manager
  never removes discovery. The elapsed 45-second budget includes host calls; a late `hc run` receipt is
  cleanup-only. A fast launch failure is confirmed by an exact finished terminal receipt; a missing live terminal
  or a failed listing alone cannot confirm exit. The bridge takes a stable exclusive lock before starting the agent
  and, while holding it, replaces only a matching or absent current file and removes only its own ready publication. Unknown reads
  or reservation failures do not permit launch. Only the bridge signals its agent group, and not after its child
  exits. Callers check `checking()` first. See ARCHITECTURE §13 for legacy migration assumptions.
- `sys/assistant-sessions.js` (takes `run(command, args, options)`, so tests run it on real sqlite3 files):
  `querySessions(run, db)` → `{rows, via: readonly|immutable|absent}` or `{error: schema|locked|open|parse|failed,
  detail}`; `profileSessions(run, home, profile)`; `listProfiles(run, home)`; `listFolderFiles(run, folder)` (at most
  2,000 folder-relative paths to depth 8, no pictures, hidden entries, `node_modules`, `.venv`, `venv`, `__pycache__`;
  one `/bin/sh -c` running `find … -print0 | head -c WALK_BYTES` (512 KiB), so the walk stops at that cap; a path the
  cut ends inside is left out);
  `resolvePaths(run, paths)` → `{[path]: resolved}` (one `/bin/sh -c` with `cd -P` and `pwd -P` per 200 absolute paths;
  `""` for one that is missing, not a folder or unreadable; paths holding a NUL or newline are left out);
  `shortFolder(run, path)` → `firmlinkShort(path)` when both forms resolve to the same folder, else `path`.

### sys/assistant.js — the service (K4)

```js
start(cx); stop()                                  // start reconnects only; stop closes sockets, bridges keep running
snapshot(): AssistantState; session(key): ChatState | null; folderFiles(): string[]
open(cx); recheck(cx); refreshList(cx, profile?)
pickFolder(cx)            // {ok, path} | {error:"busy", path} (ask, then setFolder confirmed) | {error:"cancelled"}
setFolder(cx, path, {confirmed})   // {ok, path} | {error:"busy", path}: `path` is the folder as kept (shortFolder of the given one)
newSession(cx, profile); select(cx, key); fork(cx, key)
send(cx, key, {text, attachments})                 // idle: session/prompt; running: "/steer <text>"
queue(cx, key, text); unqueue(key, chipId); resumeQueue(cx, key)
stopTurn(cx, key); answerPermission(cx, key, requestId, optionId); setModel(cx, key, modelId)
toggleGroup(profile); retryBridge(cx, profile)
openTarget(cx, profile, sessionId); parseTarget(s); onNotice(fn)   // notifications (sys/notify.js)

AssistantState = {gate: ok|checking|no-folder|folder-missing|relay|hermes-missing|hermes-check-failed, gateDetail,
                  folder, hermes:{path, version}|null, bridges:{[profile]:{state: off|starting|ready|error|stopped, error?}},
                  list: ListModel, sessions:{[key]: ChatState}, notices}
```
- Results are `{ok:true, …}` or `{error}`; codes `no-folder relay hermes-missing hermes-check-failed
  bridge-launch-failed bridge-timeout agent-exit auth disconnected busy not-found too-long too-late rpc:<code>`, and
  `cancelled` for a dismissed picker. `key` is `<profile>/<sessionId>`.
- `open` order, list sources, send routing and notices: ARCHITECTURE §13.4 and §13.6.

### Views (K7, K8)
- Each Assistant view parses `assistant:<verb>[:<arg>]` (`views/assistant/common.js` `verbOf`). The list view takes
  `new[:<profile>]` and `select:<profile>/<session>`; the chat view `focus`, `stop`, `attach:<rel>`, `allow`, `deny`,
  `send:<text>`; every copy `sample:<name>`. Copies with `props.preview` or `props.sample` draw `views/assistant/sample.js`.
- `allow` and `deny` answer with the adapter's quick answers (`allow_once`, `deny`): the selected chat's newest
  pending card, else its newest `expired` or `cancelled` one; that answer still reaches the service, which refuses it
  with `too-late` and puts the notice in the transcript (the transcript follows to show it). Answered cards are not
  asked again.
- Composer keys (`views/assistant/composer.js`) are bindings made once per runtime with `cx.bind_keys`, in contexts
  the composer's frame declares above the textarea (`key_context`), so they win over the textarea's own Enter:

  | Context (`… > Input`, `> TextArea`, `> Textarea`) | Keys → action |
  |---|---|
  | `lz_assistant_composer` | `enter` → `lz_assistant_send`; `alt-enter`, `cmd-enter` → `lz_assistant_queue` |
  | `lz_assistant_list` (the @ or / list open) | `up`, `down` → `lz_assistant_list_up`, `_down`; `tab`, `enter` → `lz_assistant_list_take` (with no rows: send); `escape` → `lz_assistant_list_close`; `alt-enter`, `cmd-enter` → queue |

  `shift-enter` is not bound and stays the textarea's new line. `cmd-enter` is there because the Korean input source
  takes `alt-enter`. The `lazuli.key:<keystroke>` hook maps the same keystrokes to the same actions.
- `views/assistant/menu.js`: `MenuButton(id, label, {open, mono, a11y, tooltip})`, `MenuIconButton(id, icon, label,
  {open})` and `MenuPopover(id, {trigger, open, onOpen, menu, anchor})` (a gpui-base `Popover`, its content built only
  while open) for the More menu, the model menu and the new-chat picker. Their triggers draw like the kit's ghost
  Button and IconButton but do not stop mouse-down, which the Popover needs to open.
- `views/assistant/cards.js` `hardBreaks(item)`: an agent message's text with each single line break kept (two spaces
  before it), because Markdown joins the lines of a paragraph and Hermes's plain replies (`/help`: one command per
  line) would read as one run-on line; fenced and indented code and table rows stay untouched, and blocks that end
  anyway (lists, headings, fences, blank lines) render as before. Memoized per item.
- `noticeBody(item, open)` → `{text, inline, words, more}` or null: a notice's detail up to 60 characters on one line
  stays inline in the code font; a longer one (an agent's error) wraps under the notice, cut to 4 lines or 280
  characters with "…" and a Show all / Show less button (`assistant.event.showAll`, `showLess`; open state per notice
  in the chat view); rule 11's `NO_REPLY` is drawn in words (`assistant.event.noReply`). The transcript's row heights
  follow the same body.
- `files-tree.js` with `props.scope === "assistant"` (and `props.block`): the root is `settings().assistant.folder`
  once the host is known to be this Mac; the refresh timer tests `blockShown(props.block)`; a click opens with
  `filetabs.open(file, {on: null, space})` in the active space, then `showCenter("work")`; no active space shows
  `filetab.quickopen.no-place`. `files-rows.js` adds Attach (`paperclip`, `assistant.files.attach`) to a file row that
  is not a picture; it runs `lazuli.assistant:attach:<rel>`. Without `scope`, the panel is unchanged.
- Catalog keys other areas use: `shell.app.assistant`, `shell.nav.assistant {running, waiting}`,
  `palette.cmd.go.assistant`, `settings.assistant.*`, `assistant.notice.{permission,done,failed} {title}`.

### Fake ACP agent (K9): `tests/fixtures/fake-acp-agent.mjs`

`node fake-acp-agent.mjs [--fail-check] -p <profile> acp` serves ACP on stdio; `… acp --check` prints `Hermes ACP
check OK` and exits 0 (with `--fail-check`, `fake: check failed` on stderr and exit 1). Shapes come from
`tests/fixtures/acp/hermes-0.17.0.json` (copied from `docs/spikes/S9/*.jsonl`). Session ids are UUID v4; sessions persist
as `$FAKE_ACP_HOME/<profile>/<sessionId>.json` (default `/tmp/fake-acp`), so `session/load` replays them after a
restart. It answers `initialize`, `session/new`, `session/load` (`{}` for an unknown id), `session/list {cwd}`,
`session/fork` (`sessionId: ""` for an unknown one), `session/set_model` (`fake:alpha`, `fake:beta`), `session/cancel`
and `session/prompt`, sends `available_commands_update` (help, model, steer, queue, version) and, after the first
turn, `session_info_update {title}`, and logs `Prompt on session <id>: <first 100 chars>` to stderr as Hermes does.

| First word | Behavior |
|---|---|
| (other) | a thought chunk, then "Echo: <text>" in 5 chunks over 1 s, `usage_update`, `stopReason: end_turn` |
| `tool` | a `tool_call` (kind execute) pending → in_progress → completed after 1.5 s with text output, then an answer |
| `edit` | `session/request_permission` with `toolCallId` `edit-approval-1`, a diff and `allow_once`, `deny`; on allow a completed edit tool with the diff |
| `approve` / `approve2` | a permission request with Hermes's five options (`approve2`: without `allow_always`); echoes the chosen option id; cancelled after 60 s without an answer |
| `slow` | one chunk a second for 20 s; a `/steer <x>` meanwhile gets Hermes's acknowledgement and "Steered: <x>" in the stream; `session/cancel` ends it `cancelled` |
| `plan` | a three-entry `plan`, then an answer |
| `burst` / `bigdiff` | 2,100 tool items as fast as possible / an edit permission with a 1 MiB diff |
| `fail` / `crash` | a JSON-RPC error for the prompt / exit 1 |
| `/help`, `/version` | text answers like Hermes's |
| any `resource_link` | each URI echoed in the answer |

Environment knobs for tests: `FAKE_ACP_PERMISSION_MS`, `FAKE_ACP_INIT=fail|hang|exit`, `FAKE_ACP_IGNORE_TERM=1`,
`FAKE_ACP_LOG=<file>`.
