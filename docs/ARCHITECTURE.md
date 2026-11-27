# lazuli architecture

**Status: READY.** Three parent decisions are open (§12); none blocks W0 or W1.

- **Context7:** not mounted in this session (`xd://` lists only cockpit, higgsfield, rea, decision_log). `marked` facts come from the npm registry and the published file instead.
- **Not executed:** I have no shell, so no `--help` was run. CLI flags are cited from files, and §12 lists the commands Main should run to confirm them.
- **Abbreviations:** `H` = `~/.config/herdr-app`; `UP` = cockpit v0.38.5 `herdr/tui/`; `REF` = this repo's `mods/`; `RELAY` = `herdr-relay/docs/`.

## 0. Verified facts that drive the design

| # | Fact | Evidence |
|---|---|---|
| F1 | `run()` returns `null`; new ids only come back from `herdr-app do` (`{pane, terminal}`) or from live data. | `H/herdr.d.ts` (`run(): null`); `REF lstack-herdr-cockpit/code.js:37-40`; `H/AGENTS.md:702-703` |
| F2 | `<mod>.<command>` reaches shown copies only; every shown copy receives it. | `H/AGENTS.md` Mods ("reaches shown copies only"); `REF lstack-herdr-cockpit/main.js:42-52` |
| F3 | Module scope runs once and is shared by all copies of a mod. | `H/AGENTS.md` Rules ("Module code runs once per source version and is shared by copies") |
| F4 | Detached launch: `hc run --bg --json --cwd D --label k=v -- cmd` → `{address}`; stop with `hc kill` + `hc rm`; liveness is `terminals()[i].state === "live"`. | `H/mods/task-browser/main.js:97-98,112-113,124,141` |
| F5 | `hc send <addr> <text>`, `hc label <addr> k=v`, `hc read <addr> --lines N`, `hc keys`, `hc get --json`. | `REF lstack-herdr/components/lh-resume.js:51,132`; `H/bin/herdr-browser-view:348-361`; `UP cli/src/queue.rs` (`send`) |
| F6 | Herdr terminals decode Kitty **PNG only**. | `H/bin/herdr-browser-view:6-9` |
| F7 | Mod built-ins: `fs/promises` (readFile bytes, writeFile, readdir, exists, unlink, rmdir, mkdir; no stat or rename), `net.connect`, `websocket`, `crypto.createHash`, `zlib`. | `H/gpui-kit.d.ts:22142-22234` |
| F8 | `marked` 18.2.1, MIT, one ESM file `lib/marked.esm.js`, `engines.node >=20`. No DOM, `process` or timers. It feature-tests RegExp lookbehind at load and uses `\p{P}\p{S}` with the `u` flag. | `registry.npmjs.org/marked/latest`; `cdn.jsdelivr.net/npm/marked@18.2.1/lib/marked.esm.js:13-14` |
| F9 | Usage fields. OMP: `message.usage{input,output,cacheRead,cacheWrite,cost.total}` plus `type:"model_usage"` records. Claude Code: `message.usage{input_tokens,output_tokens,cache_read_input_tokens,cache_creation_input_tokens,cache_creation{ephemeral_1h_input_tokens,ephemeral_5m_input_tokens}}`, no USD. Codex: `token_count` → `payload.info.total_token_usage`, no USD; an older rollout on this Mac is `.jsonl.zst`. | sampled `~/.omp/agent/sessions/-Study-Database-Project-26S2/*.jsonl:10,18`; `~/.claude/projects/-Users-lapis0875-Projects-CapstoneProject/ee16e3ea….jsonl:29`; `~/.codex/sessions/2026/11/09/rollout-….jsonl.zst`; `UP core/src/transcripts.rs:402-415,694-703,728-742,877-884` |
| F10 | cockpit formats: to-do `^- \[( |x)\] (.*)$` with ` (done YYYY-MM-DD)`; routine = `key: value` front matter + body; queue doc `{version:1,queues:{"app:tN":[{id,text,at}]}}`, mirrored to `~/.cache/cockpit/queue.json` on every write; pins = `config.json` `.spaces`. | `UP todo/src/doc.rs`; `UP core/src/routines.rs`; `UP cli/src/queue.rs`; `UP hub/src/store.rs` (`mirror`); `UP hub/src/act/pins.rs` |
| F11 | This Mac: `~/.config/cockpit/todo.md` exists; no `routines/`; no `~/.cache/cockpit/queue.json`; `terminal-notifier` is **not installed**; `pdftocairo`, `gh`, `node` are present; Herdr is `dev.herdr.app` 0.1.16. | glob of `~/.config/cockpit`, `~/.cache/cockpit`, `/opt/homebrew/bin`; `/Applications/Herdr.app/Contents/Info.plist:5,10` |
| F12 | herdr-relay: a profile only switches on rows E1, E2, E4, E5, E6, E7, E10, E11, E14, E15. `gh`, `omp`, `sh` are E16 and never enabled. `writeTextFile` is refused for every folder. `tab.new` and `pane.split` are refused as structural. A folder always reads `data/<folder>/**`. | `RELAY PROFILES.md` §1, §2, §6; `RELAY POLICY.md` §2.4, §2.6 |

## 1. Repository layout after the redesign

Every file targets under 600 lines. `core/` is pure (see §9).

| Path | Files: responsibility |
|---|---|
| `mods/lazuli/` | `main.js`: View class, `VIEWS` registry, command pump · `mod.json`: `{"place":"none","focusable":true}` · `package.json`: `{"type":"module"}` so Node loads `core/*.js` |
| `mods/lazuli/core/` (data) | `gh-map.js`: GraphQL answer → PR/CI rows · `ticket.js`: ticket link from PR body or branch · `stage.js`: agent stage · `todo-doc.js`: to-do parser/writer · `queue-doc.js`: queue edits and prompt joining · `spend.js` + `pricing.js`: usage → USD · `ledger.js`: working-time stretches |
| `mods/lazuli/core/` (routines, agents) | `routine-file.js`: front matter, `when`, cron · `routine-sched.js`: schedule/catch-up/finish reducer · `agent-cmd.js`: run/resume/fork argv and output parsing per tool · `resume-tools.js`: port of `lh-resume-tools.js` · `migrate-plan.js`: pure migration plan |
| `mods/lazuli/core/` (files) | `paths.js`: kind/mode table (B3), tilde, dedupe key, name rules · `tabs-reg.js`: tab registry reducer · `drafts.js`: draft naming and banner decision · `fuzzy.js`: quick-open scoring · `md-tree.js`: marked tokens → render tree · `lru.js`: cache eviction order · `proto.js`: line-JSON framing and message validators |
| `mods/lazuli/core/` (i18n) | `i18n.js`: `t(key, vars)`, language resolution · `catalog/index.js`: merges fragments · `catalog/<area>.en.js`, `<area>.ko.js` for areas `common shell home inbox todo routines review files tree filetab palette settings gallery viewer assistant` |
| `mods/lazuli/core/` (Assistant, §13) | `acp-wire.js`: ACP messages, the bridge's line protocol, discovery, in-flight tracker, stderr filter · `assistant-agents.js`: agent adapters (Hermes; Nod planned) · `assistant-chat.js`: chat reducer · `assistant-list.js`: list model and Hermes's session query |
| `mods/lazuli/sys/` | `store.js`: in-memory store, snapshots, settings file · `state.js`: shared-key names · `bus.js`: command table · `gh.js` · `fleet.js` · `scan.js` · `runner.js` · `routines.js` · `queue.js` · `resume.js` · `notify.js` · `migrate.js` · `sidecars.js` (pdfd build/launch) · `filetabs.js` (open, dedupe, own-tab resolution) · `search.js` (palette index) · Assistant (§13): `assistant.js` (service), `assistant-bridge.js` (bridge launch, reuse, reaping), `assistant-sessions.js` (profiles, `state.db` rows, folder files), `acp-client.js` (one bridge connection) |
| `mods/lazuli/ui/` | `tokens.js`: token contract (§11) · `kit.js`: Button, Icon, Row, Badge, Field, Tabs, Menu, Empty, Spinner, Kbd, Banner · `icons/*.svg`: Lucide subset · `logo.svg` |
| `mods/lazuli/views/` (shell) | `brand.js` · `sidebar.js` · `bell.js` · `status.js` (also hosts services) · `activity.js` · `pane-head.js` · `agent-head.js` · `palette.js` · `quickopen.js` · `settings.js` · `menu.js` · `placeholder.js` |
| `mods/lazuli/views/` (apps, panels) | `home.js` · `inbox.js` · `inbox-detail.js` · `todo.js` · `routines.js` · `routine-form.js` · `queue.js` · `recap.js` · `review.js` · `diff.js` · `files-tree.js` · `files-ops.js` · `tree.js` · `run.js` · `transcript.js` · Assistant (§13): `assistant.js` (chat), `assistant-list.js`, `assistant-info.js`, `assistant/` (`transcript`, `cards`, `composer`, `gate`, `list-parts`, `model`, `diff`, `folder`, `common`, `sample`) |
| `mods/lazuli/file/` | `model.js`: load/save/conflict/draft state machine (no elements) · `file-tab.js`: tab view, toolbar, mode switch · `md-view.js` · `pdf-view.js` · `pdf-client.js`: TCP client · `image-view.js` · `html-fallback.js` · `info-card.js` |
| `mods/lazuli/bin/` | `scan.mjs`: transcript reader (tree, detail, run, call, transcript, usage, sessions) · `run-agent.mjs`: headless run wrapper · `html-view.mjs`: terminal HTML viewer · `chrome-broker.mjs` · `pdfd.swift` · `acp-bridge.mjs`: the Assistant's ACP bridge (§13) · `lib/cdp.mjs`, `lib/kitty.mjs`, `lib/static-server.mjs`, `lib/md-page.mjs` |
| `mods/lazuli/vendor/`, `omp/` | `vendor/marked.esm.js` + `vendor/marked.LICENSE` · `omp/lazuli-tree.ts` (renamed extension, D1) |
| `layouts/`, `themes/` | `layouts/lazuli.json` · `layouts/lazuli.svg` · `themes/lazuli-light.json` · `themes/lazuli-dark.json` |
| `relay/` | `lazuli.profile.json` (§8) |
| `docs/` | `DESIGN.md` · `ARCHITECTURE.md` (this document) · `TESTING.md` (live scenarios) · `spikes/S*.md` (results) · `mockups/` |
| `tests/` | `*.test.mjs` (§9) · `fixtures/` (among them `fake-acp-agent.mjs` and `acp/hermes-0.17.0.json`, §13) |
| root | `keys.json` · `package.json` (`"test": "node --test tests/"`) · `README.md` · `README.ko.md` · `RECIPE.md` · `THIRD_PARTY_NOTICES.md` · `LICENSE` · `LICENSES/` · `preview.png` |

**Deleted:**
- `mods/lstack-herdr-cockpit/` whole, including `.lstack-sync.json`.
- `mods/lstack-herdr/` whole (`sync.mjs`, `hooks.mjs`, `main.js`) after its components are ported.
- `layouts/lstack-herdr.json` and `.svg`.
- `THIRD_PARTY_NOTICES.md` sections for cockpit, herdr-blueprint-app and herdr-editor-layout. Kept: Herdr `files` mod (Apache-2.0), Lucide (ISC); added: marked (MIT).

## 2. Mod runtime structure

| Concern | Design |
|---|---|
| View registry | `main.js` picks `VIEWS[props().view] ?? Placeholder`, calls `view.init(props, cx)`, and forwards `render` and `close`. Same shape as `REF lstack-herdr-cockpit/main.js:36-58`, but hand-written. |
| Command pump | Each copy loops on `nextCommand()` and calls `bus.dispatch(command, view, cx)`. `key:<keystroke>` goes to `view.key()` (test hook). |
| Command ownership | Window-wide commands are handled only by the `status` copy, which is always shown and exists once per layout (F2). `file-mode` is handled by the `file` copy whose `tab === focused().tab`. ⌘S is an `on_key_down` inside the editor, not a `keys.json` entry. |
| Services | The `status` copy starts every service in `init`, guarded by `checking()`: gh poll, fleet, routines tick, resume, queue, the Assistant (reconnects only, §13), notify, migration, pdfd build, ledger. |
| Store | `sys/store.js` holds a module-level map (F3). After a change the owner writes `H/data/lazuli/snap/<name>.json` and bumps `shared("lazuli.rev")[name]`, which re-renders every copy. Snapshots also give a warm start and feed relay devices (§8). |
| Settings | `H/data/lazuli/settings.json`: `{version:2, language:"system"|"ko"|"en", agent:{command:["omp"], model?}, notifications:{system:true}, gh:{org?:[], pollSec:120}, routines:{maxParallel:3}, pins:[…], pdf:{zoom:"fit"}, editor:"code", assistant:{folder:null, debugAgent:null}}`. A version 1 file gains `"assistant"` in its own `pins` once and is written back as version 2. The live copy is `shared("lazuli.settings")`, so a change applies at once (C3). |
| i18n | Flat keys per fragment, `{name}` placeholders, fallback ko → en → key. `"system"` resolves once with `exec("defaults", ["read","-g","AppleLanguages"])`: first entry starting `ko` → Korean. AI prompts append "Answer in Korean/English" from the setting. |
| Theme | Views never call `theme()` directly; they call `tokens()` from `ui/tokens.js` (§11). |

Commands (`keys.json` section `layout:lazuli`, D2):

| Key | Action string | Owner | Effect |
|---|---|---|---|
| ⇧⌘P | `lazuli.palette` | status | `openOverlay({mod:"lazuli", props:{view:"palette"}, kind:"dialog"})` |
| ⌥⌘0 | `lazuli.home` | status | `layout.select {stack:"center"}` home ↔ work |
| ⌥⌘1/2/3/4 | `lazuli.go:inbox` / `go:todo` / `go:routines` / `go:assistant` | status | `layout.select {stack:"center", child}` |
| ⌥⌘A | `lazuli.agent-view` | status | `layout.select {stack:"view"}` main ↔ agent |
| ⌥⌘B | `lazuli.panel` | status | `layout.toggle {id:"panel"}` |
| ⌘1/2/3/4 | `lazuli.panel:review` / `files` / `changes` / `tree` | status | select in `panel-body` and show; hide if already shown |
| ⌘⇧V | `lazuli.file-mode` | file | next available mode (B3) |
| ⌘⇧O | `lazuli.quickopen` | status | quick-open dialog |
| ⌘J, ⇧⌘J, ⇧⌘U | `lazuli.next-waiting`, `next:blocked`, `next:done` | status | `agent.focus {terminal}` on the next agent of that stage |
| ⌥⌘Q, ⌘R | `lazuli.queue`, `lazuli.recap` | status | dialog |
| ⌥⌘R | `lazuli.resume` | status | retry pending restores (§7) |
| ⌘G, ⌘L | `lazuli.pr`, `lazuli.ticket` | status | `exec("open", [url])` |

Shared keys (all under `lazuli.`):

| Key | Value |
|---|---|
| `rev` | `{gh, fleet, todo, routines, queue, scan, restore}` counters |
| `settings` | live settings object |
| `tabs` | file-tab registry (§6), persisted |
| `snooze` | `{address: untilMs}` |
| `seen` | attention already looked at |
| `pdfd` | `{state:"absent"|"building"|"ready"|"failed", bin, reason}` |
| `assistant.ui` | `{v:1, folder, selected:{agent, profile, session}|null, collapsed:[profile]}` (§13) |

## 3. `layouts/lazuli.json`

Root attributes: `"type":"row"`, `"titlebar":"none"`, `"traffic_lights":[12,16]`, `"background":"canvas"`, `"terminal_padding":[14,12]`, `"divider":{width:1,color:"border"}`, `"preview":"layouts/lazuli.svg"`, `"theme":{"light":"lazuli-light","dark":"lazuli-dark"}`.

```
root
├─ floating: queue  → lazuli {view:"queue"}  edge right, align center, peek 44
├─ sidebar  column px268 min44 max480 bg chrome, resizable false
│   ├─ brand           block px46 window_drag → lazuli {view:"brand"}
│   ├─ nav             block weight1 min120   → lazuli {view:"sidebar"}
│   └─ sidebar-footer  block px69             → lazuli {view:"sidebar", footer:true}   (replaces the shipped footer; keeps its functions)
└─ main-area  column, resizable false
    ├─ topbar  row px42
    │   ├─ tabs  block window_drag → tabs   (shipped)
    │   └─ bell  block px52 window_drag → lazuli {view:"bell"}
    ├─ body  row, resizable false                       ← owner decision 2026-11-19: rail always visible (DESIGN D3)
    │   ├─ center  stack active "home", padding 8
    │   │   ├─ home  row gap8
    │   │   │   ├─ home-board  block card → lazuli {view:"home"}
    │   │   │   └─ home-agent  column hidden px600 min360 max1100
    │   │   │       └─ home-agent-card  column card
    │   │   │           ├─ home-agent-head  px34 → lazuli {view:"agent-head", place:"home"}
    │   │   │           └─ home-agent-term  → {agent:"focused"}
    │   │   ├─ work  row gap8
    │   │   │   ├─ view  stack active "main"
    │   │   │   │   ├─ main   → {tab:"active", pane:{gap:8, radius:10, background:"background", lone:true,
    │   │   │   │   │            border:{1,"border"}, focus:{1,"accent"},
    │   │   │   │   │            header:{content: lazuli {view:"pane-head"}, height:30, position:"top", reveal:"always"}}}
    │   │   │   │   └─ agent  column card
    │   │   │   │       ├─ agent-head  px34 → lazuli {view:"agent-head", place:"work"}
    │   │   │   │       └─ agent-term  → {agent:"focused"}
    │   │   │   └─ panel  row hidden px420 min280 max900 card
    │   │   │       └─ panel-body  stack active "files"          ← default right panel (D3)
    │   │   │           ├─ review   → lazuli {view:"review"}
    │   │   │           ├─ files    → lazuli {view:"files"}
    │   │   │           ├─ changes  → changes   (shipped)
    │   │   │           └─ tree     → lazuli {view:"tree"}
    │   │   ├─ inbox     block card → lazuli {view:"inbox"}
    │   │   ├─ todo      block card → lazuli {view:"todo"}
    │   │   ├─ routines  block card → lazuli {view:"routines"}
    │   │   └─ assistant  row gap8                                   (§13)
    │   │       ├─ assistant-list  block px260 min220 max420 card → lazuli {view:"assistant-list"}
    │   │       ├─ assistant-chat  block weight1 min360 card       → lazuli {view:"assistant"}
    │   │       └─ assistant-side  column px300 min260 max560 gap8
    │   │           ├─ assistant-info   block px188 card  → lazuli {view:"assistant-info"}
    │   │           └─ assistant-files  block weight1 card → lazuli {view:"files", scope:"assistant", block:"assistant-files"}
    │   └─ activity  block px44 → lazuli {view:"activity", stack:"panel-body"}   (visible on every center view)
    └─ status  block px34 → lazuli {view:"status"}
```

- "card" means `radius:10`, `border:{width:1,color:"border"}`, `background:"background"`, `shadow:"sm"`.
- Ids, sizes and nesting come from `layouts/lstack-herdr.json` minus the A2 blocks (`show`, `runbook-panel`, `runbook`, `meetings`, `monitor`, `mail`).
- The pane header copy gets `props().pane` and `props().terminal` (`H/AGENTS.md` Pane frames). For a mod pane it shows the file's name from the registry.
- Decision: `brand` becomes a lazuli view (logo, C2); `tabs`, `changes` and the footer stay Herdr's shipped mods.

## 4. Data layer

### 4.1 GitHub (`sys/gh.js`, `core/gh-map.js`)

| Need | Command | Notes |
|---|---|---|
| Inbox, PR, CI in one call | `gh api graphql -f query=<Q>` | `Q` is the query of `UP hub/src/feed/github.rs` (`review`, `direct`, `mine`, `merged` searches), with two additions: `body` on `mine` (ticket link) and `rateLimit{remaining resetAt cost}`. Optional ` org:<name>` scope from settings. |
| Review threads | `gh api graphql -f query=<THREADS> -F owner=… -F name=… -F number=…` | `THREADS` verbatim from `UP hub/src/fetch.rs`; keep unresolved threads only. |
| PR files | `gh pr view <n> --repo <owner/name> --json files` | `UP hub/src/fetch.rs` (`pr_files`) |
| CI log | `gh run list --repo R --branch B --status failure --limit 1 --json databaseId`, then `gh run view <id> --repo R --log-failed` | Last 200 lines (`UP hub/src/fetch.rs` `ci_log`). |
| Failed job and step | `gh api repos/<slug>/actions/jobs/<jobId>` → first step with `conclusion == "failure"` | Job choice follows `UP hub/src/feed/github_ci.rs` (an Actions job first). Upstream returns no test names for GitHub; lazuli extracts them from the failed log with a pure pattern function. |
| Merge, rerun | `gh pr merge <n> -R <slug> --squash|--merge|--rebase`; `gh run rerun <runId> --failed -R <slug>` | [INFERENCE] flags not verified here. The merge method is the first one `gh api repos/<slug>` allows. The UI slice confirms the action list against `REF lstack-herdr-cockpit/inbox.js`. |

- **Cadence:** main query every 120 s while `window().active`, every 600 s otherwise, and at once when Inbox or Home opens with data older than 30 s.
- **Detail cache:** 180 s per `(kind, args)`; `gh` timeout 25 s (both from `UP hub/src/fetch.rs`).
- **Rate limit:** on any failure the interval doubles, up to 15 min. If `rateLimit.remaining < 200`, polling stops until `resetAt`.
- **Not signed in:** stderr containing `gh auth login` shows an empty state with that instruction; no retries until the view is reopened.
- **Routine triggers:** events are diffs of two snapshots: `review_requested`, `approved`, `changes_requested`, `pr_opened`, `merged`, `ci_failed`, `ci_passed`.

### 4.2 Agents, stages, time (`sys/fleet.js`, `core/stage.js`, `core/ledger.js`)

| Item | Source |
|---|---|
| Agent row | `agents()` (address, pane, space, tab, status, app, program, title, seq, pinned, focused) joined with `terminals()` by address (cwd, labels, parent, state, `foreground{pid,argv,cwd}`, turn; fields as used in `lh-resume.js:68-121`). |
| Branch | `exec("git", ["-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"], {on})`, cached 15 s per cwd. |
| PR and CI | `mine` rows matched on repo name + branch. |
| Stage | `needs`: status blocked, or own PR with changes requested, failing CI or unresolved threads. `working`: status working or running subagents (call-tree scan). `ready`: PR approved, CI green, not draft. `done`: the rest. |
| Ticket (⌘L) | First tracker URL in the PR body (Linear, Jira, GitHub issue), else `KEY-123` in the branch name; with no URL the key is shown and ⌘L toasts "no ticket link". |
| Weekly time | `H/data/lazuli/ledger.jsonl`, lines `{start,end,ticket,terminal}`, checkpoint every 60 s, kept 35 days (format of `UP agents/src/ledger.rs`). |
| Answer (Recap) | `hc read <addr> --lines 40` shown as text; the reply goes with `hc send <addr> <text>`. |

### 4.3 Transcripts: spend, sessions, call tree (`bin/scan.mjs`, `core/spend.js`)

| Tool | Root | Usage record | USD |
|---|---|---|---|
| OMP | `~/.omp/agent/sessions/<cwd-slug>/<time>_<id>.jsonl` (subagents in a folder beside it) | `message.usage` on assistant messages; `type:"model_usage"` records | `usage.cost.total` |
| Claude Code | `~/.claude/projects/<cwd-slug>/<session>.jsonl` (skip `agent-*`) | `message.usage`, de-duplicated by `message.id` + `requestId` (streamed replies repeat it, `UP core/src/transcripts.rs:694`) | tokens × `core/pricing.js` (per-model table; unknown model → tokens only, marked "unpriced") |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` and `.jsonl.zst` | last `token_count` → `payload.info.total_token_usage` | tokens × pricing; `.zst` read with `zstd -dc`, else counted as skipped |

- `scan.mjs usage` reads incrementally (byte offset per file in `~/.cache/lazuli/usage-cache.json`) and prints `{today, week, days[7], byTool, byModel, unpriced, skipped}`.
- `scan.mjs sessions` builds `~/.cache/lazuli/sessions-index.json`: `[{tool, id, path, cwd, title, first, last, model}]`, refreshed by (size, mtime).
- `tree`, `detail`, `run`, `call`, `transcript` keep the behavior of `REF lstack-herdr/components/lh-scan.mjs`, with the cache moved to `~/.cache/lazuli/`.

### 4.4 Palette index (`sys/search.js`)

| Source | From |
|---|---|
| Commands, keys, layouts | `commands()`, `keys()`, `layouts()`, the bus table |
| Spaces, tabs, agents | `spaces()`, fleet |
| PRs | gh snapshot (review, mine, merged) |
| To-dos, routines | their stores |
| Past sessions | `sessions-index.json`; Enter runs `tab.new {folder: cwd, argv: resumeArgv}` |

### 4.5 To-do (`core/todo-doc.js`), file `H/data/lazuli/todo.md`

| Rule | Spec (identical to `UP todo/src/doc.rs`) |
|---|---|
| Item line | trimmed line matches `^- \[( |x)\] (.*)$`; every other line is written back byte for byte |
| New file | `# To-do\n\n` |
| Add | before the first item; with no items, before the final empty line |
| Toggle | done adds ` (done YYYY-MM-DD)`; reopening removes `\s*\(done \d{4}-\d{2}-\d{2}\)$`; then open items first, done after, inside the lines items already occupy |
| Write | `writeTextFile(path, text, previousText)`; a stale write reloads and re-applies the edit once |
| Undo | last 20 texts in memory |
| Links | URL, `owner/repo#n`, `#n` (focused space's repo) |

### 4.6 Routines (`core/routine-file.js`, `core/routine-sched.js`, `sys/routines.js`)

Definitions live in `H/data/lazuli/routines/<slug>.md`.

| Field | Meaning (from `UP core/src/routines.rs`) | lazuli |
|---|---|---|
| `name` | default: slug with `-` → space | same |
| `when` | `manual`, `every 30m`, `hourly`, `daily 09:00`, `weekdays 9:00,17:30`, `mon,thu 14:00`, `cron m h dom mon dow`, `on <trigger> [words]` | same; triggers limited to `review approved changes opened merged ci-failed ci-passed any`, the rest shows "not available without cockpit" |
| `run` | `shell` or agent (default) | same |
| `agent`, `model`, `mode`, `tools`, `budget` | per-run agent options | `agent` picks an adapter (§4.8); `tools`/`budget` apply to Claude Code only, as upstream |
| `cwd` | `~` expanded; empty → the run's own folder (agent) | same |
| `timeout` | minutes, default 30 | same |
| `notify` | `always`, `failed`, `never` | same |
| `paused`, `worktree` | `true/yes/on/1` | same |
| `catch-up` | minutes a missed run may still start; default 12 h; `never` | same (assumption A1, §12) |

Scheduler, a reducer over `H/data/lazuli/routines-state.json`:
`{version:1, marks:{slug:{seen,fired,over,events}}, running:{slug:run}, queued:[{slug,why,event,late,retry}], runs:{slug:[≤20 records]}}`.

| Rule | Value |
|---|---|
| Tick | every 15 s in the `status` copy; only while Herdr runs (A6) |
| Interval | due when `now ≥ max(seen, fired) + secs` |
| Cron | `last_due(base, now)`; on time within 120 s |
| Missed runs after a restart | one run per routine (the latest due time), if late ≤ `catch-up`; later than that, one record `missed` |
| Parallel runs | 3; one per routine; an event re-fires a routine at most once per 10 min per key |
| Stop | `hc kill`; over `timeout` → stop and record `timedOut` |
| Worktree | `git -C <top> worktree add -q -b auto/<slug>-<id> ~/.herdr/worktrees/<repo>/auto/<slug>-<id> HEAD`; after the run: removed when clean with 0 commits, else kept with `{dirty, commits}`; removal never forced (`UP hub/src/routines.rs` `worktree`, `settle`, `remove_worktree`) |
| Run files | `~/.cache/lazuli/routines/<slug>/<id>.{cmd,out,err,exit,txt}` |
| Record | `{id, started, ended, ok, code, why, summary, cost?, session?, late?, missed?, stopped?, timedOut?, worktree?}` |
| Env for the run | `LAZULI_ROUTINE`, `LAZULI_ROUTINE_WHY`, `LAZULI_EVENT`, `LAZULI_EVENT_KEY`, `LAZULI_EVENT_KIND`; `CLAUDECODE`, `CLAUDE_CODE_ENTRYPOINT`, `CLAUDE_CODE_SSE_PORT` removed |

### 4.7 Queue (`core/queue-doc.js`, `sys/queue.js`), file `H/data/lazuli/queue.json`

| Item | Spec |
|---|---|
| Document | `{version:1, queues:{"<terminal address>":[{id:"q<ms>-<n>", text, at}]}}` |
| Actions | `add`, `edit`, `remove`, `move`, `clear`, `send <id|all>` (semantics of `UP cli/src/queue.rs` `edit`) |
| Prompt | one item as is; several numbered `1. …\n2. …` |
| Delivery | `hc(["send", address, prompt])`; a non-zero exit puts the items back and shows "the agent did not take it" (F5) |

### 4.8 Headless agent runner and per-tool commands (`sys/runner.js`, `core/agent-cmd.js`, `bin/run-agent.mjs`)

| Tool | Headless | Resume | Fork | Evidence |
|---|---|---|---|---|
| omp (default) | `omp -p <prompt>` (`--mode json` for usage events) | `omp --resume <id|path>` | `omp --fork <id|path>` | `omp://cli-reference.md:87-89`, Output mode and Headless sections |
| Claude Code | `claude -p <prompt> --output-format stream-json --verbose` (result carries `total_cost_usd`) | `claude --resume <id>` | `claude --resume <id> --fork-session` | `REF lh-resume-tools.js:20-32` (flags from `--help`, 2.1.311); `UP hub/src/routines.rs` `claude_argv`; `UP core/src/agent.rs` |
| Codex | `codex exec --skip-git-repo-check <prompt>` | `codex resume <id>` | `codex fork <id>` | `REF lh-resume-tools.js:57-59`; `UP core/src/agent.rs` |

- The settings command (C3) is an argv template with `{prompt}`. A command none of the adapters recognizes runs as plain text with no cost.
- **Start:** `runner.start({id, argv, cwd, env, timeoutMs})` writes `<id>.cmd`, then runs `hc run --bg --json --cwd <cwd> --label lazuli.run=<id> -- node <H>/mods/lazuli/bin/run-agent.mjs <dir>/<id>` (F4).
- **Wrapper:** `run-agent.mjs` spawns the command in its own process group with stdout → `<id>.out` and stderr → `<id>.err`. It writes `<id>.exit` as `{code, signal, ended}`, forwards SIGTERM to the group and enforces the timeout.
- **Progress:** the mod reads `<id>.exit` every 2 s while a view shows the run, every 15 s otherwise. Output tail comes from `exec("tail", ["-c", "65536", out])`. No `exec` stays open, so the 600 s cap does not apply.
- **Cancel:** `hc kill <addr>`, then `hc rm <addr>`.
- **Lost run:** no live terminal labelled `lazuli.run=<id>` and no exit file → recorded as "ended with no exit status".
- **Users:** Recap summaries (cached in `~/.cache/lazuli/recaps/<session>.json`, keyed by transcript size), Review walkthrough, Inbox start plan, agent routines.

## 5. Sidecar processes and IPC

| Process | Started by | How | Discovery | Ends |
|---|---|---|---|---|
| HTML viewer `bin/html-view.mjs` | the `file` view | `run("pane.split", {direction:"right", pane, argv:["node", ".../html-view.mjs", "--fid", fid, "--file", abs, "--kind", "html"|"md"]})` | sets its terminal title to `lazuli-view:<fid8>`; the mod finds it in `panes()` by `title` | its pane closes |
| Static server (in the viewer) | the viewer | `http.createServer` on `127.0.0.1:0` | none; private to the viewer | with the viewer |
| Chrome broker `bin/chrome-broker.mjs` | the first viewer that finds none | `spawn(process.execPath, [broker], {detached:true, stdio:"ignore"}).unref()`; the broker holds an exclusive flock on `~/.cache/lazuli/broker.lock` for its whole life (review fix) | `~/.cache/lazuli/chrome.json` (0600) | 300 s after the last lease closes |
| PDF daemon `~/.cache/lazuli/bin/pdfd-<sha8>` | `sys/sidecars.js`, on the first PDF | `hc run --bg --json --cwd ~ --label lazuli.sidecar=pdfd -- <bin> --cache <H>/data/lazuli/cache/pdf --discovery ~/.cache/lazuli/pdfd-<home8>.json --idle 300` | `~/.cache/lazuli/pdfd-<home8>.json` (0600; `<home8>` = first 8 hex of sha256(app home); reused only when the build and the recorded `cache` both match this home) | 300 s with no connection |
| Headless run `bin/run-agent.mjs` | `sys/runner.js` | §4.8 | label `lazuli.run=<id>` + run files | command exit |
| ACP bridge `bin/acp-bridge.mjs`, one per Hermes profile | `sys/assistant-bridge.js`, when the Assistant screen opens | `hc run --bg` with label `lazuli.assistant.v2=<profile>` (§13.2) | `~/.cache/lazuli/assistant/<home8>/v2/<profile>.json` (0600, folder 0700) | 30 min idle, Herdr gone, authenticated shutdown, a signal, or agent exit; its terminal is reaped |

**HTML viewer (B7, B8)**
- Chrome is driven over CDP: `Page.startScreencast {format:"png"}` (F6), each frame drawn as one Kitty image replaced in place.
- Mouse via SGR 1006/1016, keys, paste and `Input.insertText` are forwarded. Modeled on `H/bin/herdr-browser-view:74-120`.
- The viewer watches the file itself and reloads after a save, restoring `scrollX/scrollY`. The mod sends it nothing.
- Top line: path, reload, open in browser, console error count.
- Navigation: same-origin and anchors stay inside; other http(s) → `open <url>`.
- No browser found (order: Google Chrome, Chromium, Microsoft Edge, Brave): the viewer is not started and the mod shows `html-fallback.js`.

**Static server**
- Root: `git -C <dir> rev-parse --show-toplevel`, else the file's folder.
- GET and HEAD only; `Host` must equal `127.0.0.1:<port>`; the real path must stay under the root.
- No directory listing; `Cache-Control: no-store`.
- For `--kind md` it also serves `/__lazuli/md/<rel>`: the saved file rendered by `marked` with mermaid and KaTeX loaded from a pinned CDN URL (network is allowed, B8).

**Chrome broker**

| Message (TCP `127.0.0.1:leasePort`, one JSON per line) | Direction | Fields |
|---|---|---|
| `hello` | viewer → broker | `{op:"hello", token, fid, pid}` |
| `ready` | broker → viewer | `{ok:true, browserWs, cdpPort}` |
| `ping` / `pong` | both | `{op:"ping"}` / `{ok:true}` |
| `chrome-exit` | broker → viewer | `{event:"chrome-exit", code}`; the broker starts Chrome once more |
| `chrome-ready` | broker → viewer | `{event:"chrome-ready", browserWs}`; viewers reopen their page |

- Discovery file: `{version:1, brokerPid, chromePid, leasePort, token, cdpPort, browserWs, browser, startedAt}`.
- Chrome flags: `--headless=new --remote-debugging-port=0 --user-data-dir=~/.cache/lazuli/chrome-profile --no-first-run --no-default-browser-check`; the port is read from `DevToolsActivePort`.
- A lease is the open connection: one Chrome tab per viewer; closing the connection closes the tab.
- Crash recovery: if the lease socket drops, the viewer reads the discovery file again; it starts a new broker only when a probe finds `broker.lock` free (the OS releases the flock however the broker died). Nothing deletes `chrome.json` or the lock file; a broker that loses the race exits 0, and only Chrome start failures count toward the 3-failure limit.

**PDF daemon (B9)**
- Build: at layout start the `status` copy hashes `bin/pdfd.swift`. If `pdfd-<sha8>` is missing it runs `exec("swiftc", ["-O", src, "-o", bin], {timeout: 600000})` inside `cx.spawn` and sets `shared("lazuli.pdfd")`.
- Build failure: one toast, then `pdftocairo -jpeg -jpegopt quality=90 -scale-to-x <w> -f N -l N` per page; without it, "Open in Preview".
- Transport: `net.connect("127.0.0.1", port)`; the first line is `{op:"hello", token}`. Requests carry `id`; answers echo it; errors are `{id, error:{code, message}}` with codes `auth bad_request not_found encrypted render_failed`.

| `op` | Request | Answer |
|---|---|---|
| `open` | `{path}` | `{doc, pages, title, sizes:[[w,h]…], hasOutline}` |
| `render` | `{doc, page, width}` | `{path, width, height, ms}` (`path` relative to `H`) |
| `search` | `{doc, query, limit}` | `{hits:[{page, rects:[[x,y,w,h]…], snippet}], truncated}` (rects 0..1, top-left origin) |
| `links` | `{doc, page}` | `{links:[{rect, kind:"page"|"url", page?, url?}]}` |
| `outline` | `{doc}` | `{items:[{title, page, depth}]}` |
| `text` | `{doc, page}` | `{text}` |
| `close`, `ping` | `{doc}` / `{}` | `{ok:true}` |

- JPEG name: `data/lazuli/cache/pdf/<docKey>/p<page>-w<width>-<seq>.jpg`. `docKey` = first 16 hex of sha1("<path>|<mtime s.ns9>|<size>|<inode>|<ctime s.ns9>"), from `stat` with symlinks followed (review fix: same-second, same-size replacements get a new key; the pdftocairo fallback computes the same key with `stat -L -f "%HT|%.9Fm|%z|%i|%.9Fc"`); `seq` rises for every render, so a name is never rewritten. Renders of a replaced revision are deleted once no client has it open.
- Cache: the daemon owns the folder. It keeps the total under 300 MB by deleting least recently requested files and rebuilds its totals from the folder at start. A view that finds its file gone asks again.

## 6. File tab model

| Topic | Design |
|---|---|
| `tab.new` | `run("tab.new", {space, mod:"lazuli", name, focus:true, props:{view:"file", fid, file, on, preview, mode?, line?}})`. `fid` = `crypto.randomUUID()`; `name` = `◦ ` + basename for a preview tab. |
| Registry | `shared("lazuli.tabs")[fid] = {file, on, preview, mode, space, tab, pane, at}`. It overrides `props.file`, so a preview tab that switched files keeps its file after a restart (B2). |
| Own ids | At first render: `tab = focused().tab`, accepted when `panes()` has a `mod === "lazuli"` pane in that tab that no other `fid` claims; `pane` is that pane; `space` is the space whose `tabs` contain it. Retried on each render until it resolves. [INFERENCE] `focused().tab` is the copy's tab at first show; S6 checks it. |
| Dedupe | Key = `(on ?? "") + ":" + normalized absolute path`. Same key in the target space → `tab.select`. Target space = the space of the pane the Files tree follows. |
| Preview replacement | A preview entry in that space is retargeted: registry `file` changes, `tab.rename`, `tab.select`. A first edit or a double click sets `preview:false` and renames without `◦`. |
| Dirty marker | On the clean ↔ dirty transition only: `tab.rename {id: tab, name: "● " + base}` and back. |
| Stale entries | The `status` copy drops an entry whose tab is absent from `spaces()` on two ticks in a row, once that machine's layout is `ready`. |
| Modes (B3) | `core/paths.js`: `kindOf(name)` → `md html pdf svg image text binary`; `modesFor(kind)`; default per the B3 table. |
| Editing (B4) | Load with `readTextFile(abs, {on})`. Read-only when over 400,000 characters (truncated), containing NUL, `test -w` fails, or `on` is set. Undecodable → info card. Save with `writeTextFile(abs, text, diskText)`; a stale save shows Reload / Overwrite. |
| Reload | One `watchFolder(dirname)` for the shown tab plus a 10 s timer. A changed file with no unsaved edits reloads by itself; a hidden tab revalidates when shown. |
| Drafts (B5) | `H/data/lazuli/drafts/<sha1(key)>.<sha1(fid)[0:16]>.json` = `{version:1, file, on, baseHash, text, at}`: one draft per tab buffer (review fix r4), so the same file open in two spaces keeps two drafts. Written every second while dirty and changed; save or discard deletes only that buffer's draft. On open, the buffer's own draft shows the banner first; otherwise orphan drafts of the same file (their tab is gone, or old unowned `<sha1(key)>.json`) are offered newest first, never one a live tab owns. |
| Closing | `close()` has 250 ms, so there is no prompt; the draft covers unsaved edits. |
| Remote (B10) | `on` set → read-only; kinds `md` and `text` only; others show the info card; polling every 10 s instead of a watch. |
| Quick open (B11) | Root = the focused pane's folder. List: `git -C root ls-files --cached --others --exclude-standard`, else `find` to depth 6; cap 20,000. `core/fuzzy.js` ranks; top 50 shown. Enter opens a preview tab, ⌘Enter a pinned one. |

HTML mode switching (B7). The mode shown is derived from the panes; the registry stores the wanted mode.

| To | Steps |
|---|---|
| Split | no viewer pane → `pane.split` (§5); zoomed → `pane.zoom {pane: viewer}` to unzoom |
| Preview | ensure the viewer pane, then `pane.zoom {pane: viewer}` |
| Edit | `pane.close {pane: viewer}`; Chrome stays up 5 min, so reopening takes under a second |
| After a reboot | a viewer pane whose title is not `lazuli-view:<fid8>` is a bare shell (`H/AGENTS.md`: a lost terminal's command is never run again) → close it and split again |

Markdown preview (B6):
- `core/md-tree.js` turns `lexer(text)` tokens into a tree of `heading paragraph list blockquote code table hr image html`.
- `file/md-view.js` draws each block with theme tokens and re-parses 150 ms after the last edit. Unchanged blocks are reused by the hash of `token.raw`.
- Code blocks use read-only `EditorState`s, at most 40 highlighted, created outside `render` (pattern in `H/mods/workspace-reader/main.js:91-98`) and released in `close`.
- Local images: bytes copied to `H/data/lazuli/cache/img/<sha1 of content>.<ext>` (cap 20 MB each, 200 MB LRU). A content-named file is never rewritten. Remote images show alt text and a link.
- Links: http(s) → `open`; a relative file → `filetabs.open`; `#anchor` → scroll to the heading.

## 7. Migration, session restore, notifications

Migration (`sys/migrate.js` executes the plan from `core/migrate-plan.js`). It runs in the `status` copy when `H/data/lazuli/migrated.json` is absent and `checking()` is false. Every step is safe to repeat.

| # | Step | Detail |
|---|---|---|
| 1 | To-do | copy `~/.config/cockpit/todo.md` → `H/data/lazuli/todo.md` if the target is absent |
| 2 | Routines | copy `~/.config/cockpit/routines/*.md` (not dot files) → `H/data/lazuli/routines/`; a missing folder copies nothing |
| 3 | Pins | read `.spaces` of `~/.config/cockpit/config.json` (strings or `{name}`), keep `inbox todo routines` → `settings.pins`. The file holds tokens (`UP hub/src/act/pins.rs`): nothing else is copied or logged. |
| 4 | Queue | `~/.cache/cockpit/queue.json` → `H/data/lazuli/queue.json`; keys `app:tN` → `tN`; other handles dropped; a missing file means an empty queue (F10) |
| 5 | Label | each terminal with `lstack-herdr.resume`: `hc label <addr> lazuli.resume=<value>`, then `hc label <addr> lstack-herdr.resume=`; machines still loading are retried at the next start |
| 6 | Cache | `exec("rm", ["-rf", home() + "/.cache/lstack-herdr"])`, the path checked as an exact string |
| 7 | Marker | `migrated.json` = `{version:1, at, counts, pendingMachines}`; one toast with the counts. A failed step writes no marker and is retried. |

Session restore (A7; `sys/resume.js`, a port of `lh-resume.js` with label `lazuli.resume`):
- The record gains `tried`: `{tool, session, argv, cwd, pid, tried}`.
- A recorded terminal whose process is no longer `pid` is **pending** until its shell prompt shows.
- It is **failed** when `hc send` fails, or when the tool has not started 30 s after the send.
- Both lists go to the store as `restore`; Home shows them as lost agents.
- ⌥⌘R sends the resume line again to every pending or failed terminal that sits at its shell.

Notifications (A8; `sys/notify.js`):

| Window | Action |
|---|---|
| active | `notify({title, body, level, action:{name:"lazuli.target:<target>"}})` |
| not active, `terminal-notifier` found | `exec(tn, ["-title","lazuli","-subtitle",title,"-message",body,"-group","lazuli:"+key,"-activate","dev.herdr.app","-execute","env HERDR_APP_HOME=<H> <home>/.local/bin/herdr-app do agent.focus --terminal <addr>"])`. `<addr>` must match `^[A-Za-z0-9._/-]+$`, else no `-execute`. |
| not active, not found or exit ≠ 0 | `notify()` plus `setBadge(String(count))` |

- Sources: agent turned blocked or done (once per address + status + seq), routine end (per its `notify`), gh events, and the Assistant's notices (an approval request, a finished or failed turn, §13.4), whose click runs `lazuli.target:assistant:<profile>:<session>` (in the window, or through `-execute "… herdr-app do lazuli.target:assistant:<profile>:<session>"`).
- `-sender` is not used; terminal-notifier's docs say it cannot be combined with `-execute`. [INFERENCE] not re-checked here; S2 covers it.

## 8. herdr-relay profile (`relay/lazuli.profile.json`)

```json
{ "id": "lazuli", "folders": ["lazuli"], "requires": { "herdr": ">=0.1.16" },
  "reads": { "appHome": ["icons/**", "my-icons/**", "layouts/*.svg"], "spaces": true },
  "writes": { "extra": ["~/.cache/lazuli/**"] },
  "exec": { "rows": ["E1", "E2", "E4", "E6", "E7", "E11"] },
  "scripts": {
    "mods/lazuli/bin/scan.mjs": { "subcommands": ["tree","detail","run","call","transcript","usage","sessions"], "maxArgs": 3,
      "allow": { "read": ["~/**"], "write": ["~/.cache/lazuli/**"], "run": ["ps"] } },
    "mods/lazuli/bin/run-agent.mjs":     { "refuse": "Agent runs start only in the Herdr window" },
    "mods/lazuli/bin/html-view.mjs":     { "refuse": "The HTML viewer runs only in the Herdr window" },
    "mods/lazuli/bin/chrome-broker.mjs": { "refuse": "The HTML viewer runs only in the Herdr window" },
    "mods/lazuli/bin/acp-bridge.mjs":    { "refuse": "The Assistant bridge runs only in the Herdr window" } },
  "overlay": "device" }
```

| On a device | Result | Why |
|---|---|---|
| Home, Inbox, To-do, Routines, sidebar, status | render from `H/data/lazuli/snap/*.json` and the data files | default read root `data/lazuli/**` (`RELAY PROFILES.md` §2). `sys/gh.js` switches to snapshot mode when `gh` returns code 126 with stderr `herdr-relay:`. |
| git marks, branch | work | E4 |
| Call tree, spend | work | E1 (`scan.mjs` runs under Deno; it may use only `node:` built-ins and `ps`) |
| Open link | opens on the device | E11 |
| `gh`, `omp`, `sh`, `hc send/label/run/kill` | refused | E16; E7 allows reads only |
| Saving a file, editing To-do | refused | `writeTextFile` is off for every folder |
| Opening a file as a tab | refused | `tab.new` is structural |
| Assistant | a desktop-only notice; no folder, chat or token reaches the device | the views gate on the host probe (`views/apps/snapshot.js` `hostLocal()`) and never call `open`; the store `assistant` has no snapshot; the bridge script is refused |
| Markdown local images, PDF pages | not drawn | the static route does not serve `data/lazuli/**` (`RELAY POLICY.md` §2.1) |

Install (README): copy to `~/.herdr/herdr-relay/profiles/lazuli.json`, `chmod 600`, restart the bridge (`RELAY PROFILES.md` §3). Three rows conflict with D4 as written: see P1.

## 9. Testing

**Isolation rule.** `core/**` imports only relative files and `vendor/marked.esm.js`: never `herdr`, `gpui-kit`, `gpui-base`, `net`, `fs/promises`. Time, random values and file contents are passed in as arguments. `bin/**` is Node code and is tested directly.

| D6 item | Test file | Must cover (negative and boundary cases included) |
|---|---|---|
| gh result mapping | `gh-map.test.mjs`, `stage.test.mjs`, `ticket.test.mjs` | direct/team/bot split; failing checks; a PR with no checks; merged rows need a merge commit; org scope strips unsafe characters; every stage rule; ticket from body before branch; no ticket |
| routine scheduling | `routine-file.test.mjs`, `routine-sched.test.mjs` | the upstream `next_after` table (12 cases); bad `when` texts give errors; `set_field` keeps the rest; catch-up runs once; late beyond the window records `missed`; interval from the last run; 3 at once; timeout; a paused routine never queues |
| drafts | `drafts.test.mjs` | banner only when the draft differs from disk; base changed on disk; delete after save and after discard |
| path handling | `paths.test.mjs`, `tabs-reg.test.mjs`, `fuzzy.test.mjs` | the whole B3 table; names `.`, `..`, with `/`, empty; dedupe key with a machine; preview retarget; pin on edit; no retarget of a dirty tab |
| migration | `migrate-plan.test.mjs` | missing folders; existing targets not overwritten; `app:t3` → `t3`; pins filtered; a second run plans nothing; tokens never appear in the plan |
| i18n | `i18n.test.mjs` | key sets equal in both languages; placeholders equal; no empty text; fallback order |
| other pure logic | `todo-doc.test.mjs`, `queue-doc.test.mjs`, `spend.test.mjs`, `agent-cmd.test.mjs`, `resume-tools.test.mjs`, `md-tree.test.mjs`, `lru.test.mjs`, `proto.test.mjs` | upstream to-do and queue cases; Claude duplicate usage lines counted once; unknown model unpriced; argv per tool; a partial JSON line held until complete; oversized line refused |
| structure | `purity.test.mjs`, `layout.test.mjs`, `theme.test.mjs`, `relay-profile.test.mjs`, `static-server.test.mjs` | forbidden imports in `core/`; unique layout ids; every `view` exists in `VIEWS`; every `keys.json` action is in the bus table; `panel-body.active === "files"`; the Assistant's center child, columns, views and ⌥⌘4; the settings 1→2 pins migration; contrast ≥ 4.5 for each text/background token pair; 16 ANSI colors; profile scripts exist; `..` and a wrong `Host` are refused |
| Assistant (§13) | `acp-wire.test.mjs`, `assistant-agents.test.mjs`, `assistant-chat.test.mjs`, `assistant-list.test.mjs`, `assistant-sessions-sql.test.mjs`, `assistant-owned-sessions.test.mjs`, `acp-bridge.test.mjs`, `fake-acp-agent.test.mjs` | the chat reducer's eleven rules with deadlines at 59,999/60,000/60,001 ms, approval buttons by option id, a reply-less turn failing with its agent error or no-reply, and a running turn applied again after a load showing once; cwd equality, firmlink short forms, hidden profiles, `default` first, Nod last, UI state of another folder reset; argv always with `-p`; discovery reuse by profile, folder, Herdr and agent argv; the tracker's turns and loads; stderr lines redacted and Hermes's error lines read as agent errors; the bridge's auth, file modes, token kept out of the log, loopback, hello, replay and `gap`, a stream that starts over with `turns`, `agent-error` records, `replaced`, ping, idle exit and none with a prompt or approval open, Herdr gone within 5 s (12 s with a running prompt), SIGHUP, agent crash, a 5 MiB burst in order, a 16 MiB line dropped; the session query on a WAL database built from Hermes's schema and a missing column read as `schema`; Hermes local sessions: only the owned ones read by id (legacy and gateway schemas, outside the 1,000-row limit, archived ones flagged), other folders', profiles' and editors' local chats hidden, an owned chat selected and loaded with its usage after a reload; with `start` then `open` and the inventory held back, a reload during the chat's first turn keeps it selected and loads it with its transcript and cost without a select call, a newer selection wins, and one Hermes has no session for, archived, moved or owned elsewhere is not kept; with a fake gateway that loses a running prompt's answer to a load (la-c13), a reload mid-turn sends no load until the answer, streams the turn once, then loads once (one transcript, idle, cost), a select or Stop without the answer keeps the turn running, identical repeated turns stay two, and an ACP chat still loads mid-turn; every fake-agent row against the recorded Hermes shapes |

**Live window** (`docs/TESTING.md`, owner: testcode-writer):
1. Start a second Herdr with a scratch home: `HERDR_APP_HOME=/tmp/lazuli-home`, with `mods/lazuli`, the layout, themes and keys copied in. [INFERENCE] a second instance per home works; S6 confirms it.
2. `herdr-app check /tmp/lazuli-home/mods/lazuli` must pass.
3. Drive scenarios with `herdr-app do lazuli.<command>` and `lazuli.key:<keystroke>`; read `herdr-app status`; save evidence with `herdr-app shot <file>.png`.
4. Relay: load the profile with the `ProfileSet.load` snippet of `RELAY PROFILES.md` §9, then check that the base screens render on a device.

## 10. Risk spikes (before the bulk of implementation)

All run in the scratch home with a throwaway mod `lz-spike`. Each result goes to `docs/spikes/S<n>.md` with a screenshot.

| # | Question | Steps | Pass | Fail → fallback |
|---|---|---|---|---|
| S1 | Kitty graphics and SGR mouse in a terminal pane split into a mod tab (about 40 min) | 1. `tab.new {mod:"lz-spike"}`. 2. `pane.split {direction:"right", pane, argv:["node","probe.mjs"]}`. 3. The probe sets title `lz-probe`, draws a PNG with `ESC _G`, enables 1003/1006/1016 and prints mouse events. 4. Click, wheel, type Hangul. 5. `pane.zoom`, then `pane.close`. | image visible in `herdr-app shot`; pixel mouse reports arrive; the pane's `title` in `panes()` is `lz-probe`; zoom fills the tab; the process gets SIGHUP on close | no image or mouse → HTML Preview uses `html-fallback.js` plus "Open in browser"; owner decision |
| S2 | terminal-notifier on macOS 27 (about 20 min; the owner installs it with Homebrew first) | 1. Post with `-activate dev.herdr.app -execute "<herdr-app> do agent.focus --terminal <t>"` while Herdr is in the background. 2. Click it. 3. Repeat with `do lazuli.target:inbox`. | banner shows; click focuses that agent; exit code 0 | A8 fallback (toast + badge); if only the mod command fails, non-agent targets just activate Herdr |
| S3 | `image()` reload (about 20 min) | 1. Show `image("data/lz-spike/a.jpg")`. 2. Overwrite `a.jpg` with other pixels. 3. Show `b-1.jpg`, then `b-2.jpg`. | unique names always show the new picture (required); note whether the overwritten file updates | unique names stale → blocker, report to owner |
| S4 | `net` and `websocket` in a live window (about 20 min) | 1. Node echo server on 127.0.0.1. 2. `net.connect` → write, read. 3. `WebSocket.connect("ws://127.0.0.1:<p>")`. 4. Same under `herdr-app check`. | TCP round trip works live (required); record what `websocket` and `check` do | TCP refused → PDF falls back to one `exec` of a `pdfd --once` call per request |
| S5 | `hc run --bg` detachment (about 30 min) | 1. Start `sh -c 'sleep 900; echo done > /tmp/lz-s5'` with a label. 2. Check `terminals()` state and labels, and that no pane, tab or agent row appears. 3. Quit and reopen Herdr. 4. `hc kill`, `hc rm`. 5. Repeat with `omp -p hi`; watch for a Herdr "agent finished" toast. | survives past 600 s and a window restart; invisible in panes; kill ends the process group | visible or toasts → wrapper started with `exec("sh", ["-c", "nohup … &"])` and a pid file |
| S6 | Tab identity and `pane.split` (about 30 min) | 1. Open three mod tabs, one with `focus:false`. 2. Log `focused().tab` in `init`. 3. Restart Herdr; log again and read `shared`. 4. Run `herdr-app do tab.new` with `mod` and note what it prints. | each copy resolves its own tab; the registry survives the restart | wrong tab → the opener calls `herdr-app do tab.new` through `exec` and stores the printed ids |
| S7 | `marked` under QuickJS and inline text (about 30 min) | 1. `import { lexer } from "./vendor/marked.esm.js"`; `herdr-app check`. 2. Lex a file with emphasis next to Korean punctuation, tables and nested lists. 3. Draw one paragraph with `TextView.markdown` and one with wrapped spans; click a link. | import and lexing work; one inline path gives theme colors and link clicks | import fails → parse in `bin/` with Node and pass tokens as JSON |

## 11. Task split

Roles: BE = backend-implementer, UI = ui-designer, TC = testcode-writer. A slice edits only the paths it owns; everything else is forbidden.

| ID | Wave | Role | Owns (exclusive) | Depends on | Done when |
|---|---|---|---|---|---|
| T00 | 0 | BE | `docs/spikes/**` | none | S1–S7 recorded with pass/fail |
| T01 | 0 | BE | `mods/lazuli/main.js`, `mod.json`, `package.json`, `sys/store.js`, `sys/state.js`, `sys/bus.js`, `core/i18n.js`, `core/catalog/index.js`, `core/catalog/common.*`, empty stubs for every other file of §1, `layouts/lazuli.json`, `keys.json`, root `package.json` | none | `herdr-app check` passes on placeholders; `layout.test` and `purity.test` green |
| T10 | 1 | BE | `core/gh-map.js`, `ticket.js`, `stage.js`, `ledger.js`, `sys/gh.js`, `sys/fleet.js` | T01 | its tests green; a snapshot file appears from a live `gh` call |
| T11 | 1 | BE | `core/todo-doc.js`, `queue-doc.js`, `sys/queue.js` | T01 | its tests green; a cockpit `todo.md` round-trips byte for byte |
| T12 | 1 | BE | `core/routine-file.js`, `routine-sched.js`, `agent-cmd.js`, `sys/runner.js`, `sys/routines.js`, `bin/run-agent.mjs` | T01, S5 | its tests green; a 12-minute shell run finishes and is recorded |
| T13 | 1 | BE | `bin/scan.mjs`, `core/spend.js`, `pricing.js`, `sys/scan.js`, `sys/search.js`, `omp/lazuli-tree.ts` | T01 | its tests green; `usage` prints totals for all three tools on this Mac |
| T14 | 1 | BE | `core/resume-tools.js`, `migrate-plan.js`, `sys/resume.js`, `sys/migrate.js`, `sys/notify.js` | T01, S2 | its tests green; a dry run prints the plan for this Mac |
| T15 | 1 | BE | `core/paths.js`, `tabs-reg.js`, `drafts.js`, `fuzzy.js`, `md-tree.js`, `lru.js`, `sys/filetabs.js`, `file/model.js`, `vendor/**` | T01, S6, S7 | its tests green; open, dedupe and preview replacement work with a placeholder view |
| T16 | 1 | BE | `bin/html-view.mjs`, `bin/chrome-broker.mjs`, `bin/lib/**` | S1 | viewer shows a page, reloads on save and keeps scroll; Chrome exits 5 min after the last viewer |
| T17 | 1 | BE | `bin/pdfd.swift`, `core/proto.js`, `sys/sidecars.js`, `file/pdf-client.js` | S3, S4 | all seven ops answer; cache stays under 300 MB in a 500-page run |
| T18 | 1 | TC | `tests/**`, `docs/TESTING.md` | T01 (signatures from this document) | every §9 file exists and fails only for missing code |
| U1 | 2 | UI | `ui/**`, `themes/**`, `layouts/lazuli.svg`, `preview.png` | design pick, T01 | `theme.test` green; kit gallery screenshot in both appearances |
| U2 | 2 | UI | `views/brand.js`, `sidebar.js`, `bell.js`, `status.js`, `activity.js`, `pane-head.js`, `agent-head.js`, `palette.js`, `settings.js`, `menu.js`, `catalog/shell.*`, `palette.*`, `settings.*`, `layouts/lazuli.json` (moves `activity` out of `panel` into the `body` row per §3) | U1, T10, T13, T14 | D2 keys act; language switch applies at once; rail visible and working on Home |
| U3 | 2 | UI | `views/home.js`, `inbox.js`, `inbox-detail.js`, `todo.js`, `routines.js`, `routine-form.js`, `queue.js`, `recap.js`, `catalog/home.*`, `inbox.*`, `todo.*`, `routines.*` | U1, T10, T11, T12 | each A3 function of these rows shown in a screenshot |
| U4 | 2 | UI | `views/review.js`, `diff.js`, `files-tree.js`, `files-ops.js`, `tree.js`, `run.js`, `transcript.js`, `catalog/review.*`, `files.*`, `tree.*` | U1, T13, T15 | tree operations and line comments work; the call tree matches the reference |
| U5 | 2 | UI | `file/file-tab.js`, `md-view.js`, `pdf-view.js`, `image-view.js`, `html-fallback.js`, `info-card.js`, `views/quickopen.js`, `catalog/filetab.*` | U1, T15, T16, T17 | every B3 row, B4, B5, B9 and B11 shown in a screenshot |
| T90 | 3 | BE | deletion list of §1, `relay/**`, `README.md`, `README.ko.md`, `RECIPE.md`, `THIRD_PARTY_NOTICES.md`, `.gitignore` | all above | `relay-profile.test` green; no `cockpit` or `lstack` string left outside `docs/` and the migration files |

**Verification per slice:** `node --test tests/`, then `herdr-app check` on the scratch-home copy, both run by Main after the wave lands. **Integration order:** T00 → T01 → W1 in parallel → U1 → U2–U5 in parallel → T90 → live scenarios → relay check.

**Design-token contract** (`ui/tokens.js`; the only place that reads `theme()`):

| Token | `theme()` name | Token | `theme()` name |
|---|---|---|---|
| `bg.app` | `canvas` | `text.primary` | `foreground` |
| `bg.chrome` | `chrome` | `text.secondary` | `muted` |
| `bg.card` | `background` | `text.tertiary` | `dim` |
| `bg.surface` | `surface` | `text.onAccent` | `accent_foreground` |
| `bg.raised` | `raised` | `accent` | `accent` |
| `bg.popover` | `popover` | `accent2` | `ansi3` (the theme sets it to the palette's secondary) |
| `bg.hover` | `hover` | `button.bg` / `button.text` | `solid` / `solid_foreground` |
| `bg.selected` | `selected` | `state.working/blocked/done/idle/unknown` | same names |
| `line.soft` | `border` | `diff.add` / `diff.remove` | `ansi2` / `ansi1` |
| `line.strong` | `input` | `syntax.keyword/string/function/type/number/comment` | `ansi5/ansi2/ansi4/ansi3/ansi1/dim` |
| `selection` | `selection` | fonts | `settings().ui_font`, `settings().font_family` |

Fixed scales, the same for every direction: spacing 2, 4, 6, 8, 12, 16, 24; radius 4, 6, 10; text 11, 12, 13, 15, 18, 22; row height 24, 28, 32; icon 14, 16.

## 12. Parent decisions, assumptions, evidence to collect

| # | Issue | Evidence | Recommendation |
|---|---|---|---|
| P1 | D4 cannot be met by a profile alone. A profile cannot allow `gh`, `omp` or `sh`. Saving is refused, so "guarantees editing" does not hold. Opening a file tab from a device is refused. | F12 | Ship §8: devices get read-only screens from snapshots, the call tree, and Markdown preview of tabs already open. The alternative is to add rows to herdr-relay itself, a separate project. |
| P2 | `terminal-notifier` is not installed on this Mac. | F11 | The owner runs `brew install terminal-notifier` before S2; A8's fallback stays the default until S2 passes. |
| P3 | Claude Code and Codex transcripts carry tokens, not dollars. | F9 | Ship a price table in `core/pricing.js`, show unpriced models as tokens, document that the table needs updating. |

Assumptions (change on request):
- **A1:** a missed routine runs once after a restart only inside its `catch-up` window (default 12 h); later it is recorded as missed. This reads A6 together with A9's format compatibility.
- **A2:** `brand` is a lazuli view; `tabs`, `changes` and the sidebar footer stay Herdr's shipped mods.
- **A3:** migrated shell routines that read `COCKPIT_ROUTINE*` variables will not find them. Exporting those names too is a one-line change if the owner wants it.

Evidence collected by Main (2026-11-19):

| Check | Result |
|---|---|
| `hc run --help` | `--bg`, `--json`, `--cwd`, `--label K=V`, `--name`, `--no-parent`, `--outlive-parent`, `--keep`, `--rm`, `--on` exist |
| `node --version` | v26.13.0 (global `WebSocket` available) |
| `omp --version` | omp/18.22.2; `--fork <session>` documented in `omp://cli-reference.md:89`; `-p/--print`, `--mode json`, `-r/--resume` in `--help` |
| `claude --version` / `--help` | 2.1.311; `--print`, `--output-format stream-json`, `--resume <id>`, `--fork-session` present |
| `codex --version` / `codex fork --help` | codex-cli 0.167.0; `codex fork [SESSION_ID] [PROMPT]`; `codex exec --skip-git-repo-check --json` present |
| `zstd --version` | v1.5.7 |
| decision-log | recording `off` for this repository; no records |

## 13. Assistant screen (DESIGN E; lazuli-assistant plan, 2026-11-23)

Tested with Hermes Agent 0.17.0 (ACP protocol 1, `agent-client-protocol` 0.9.0). The spikes behind it are
`docs/spikes/S8.md` (the bridge transport in a live window) and `docs/spikes/S9.md` (the Hermes handshake without
tokens; the recorded messages are `docs/spikes/S9/*.jsonl`). Module contracts: CONTRACTS "Assistant".

### 13.1 Processes and files

```
Assistant views (local window only) ──K4 calls──► sys/assistant.js  (module state; the status copy runs it)
                                                    │  sys/acp-client.js per profile: one stream socket, short send sockets
                                                    ▼  127.0.0.1:<port>, token from the discovery file
hc run --bg … node bin/acp-bridge.mjs --profile <p> …    (terminal label lazuli.assistant.v2=<p>; one per profile)
                                                    │  stdio, one JSON-RPC object per line
                                                    ▼
<abs hermes> -p <p> acp                           (its own process group; cwd = the assistant folder)
```

| Path | Mode | Writer | Content |
|---|---|---|---|
| `~/.cache/lazuli/assistant/<home8>/v2/` | 0700 | the bridge | `<home8>` = first 8 hex of sha256(app home), as for pdfd (§5) |
| `<profile>.json.lock` | 0600 | the bridge | stable inode; never unlink; kernel releases the exclusive lock at process exit |
| `<profile>.json` | 0600 | only the lock holder, via a 0600 temp file and rename | `{version:1, launchId, pid, agentPid, argv, port, token, profile, cwd, herdrPid, startedAt}` after `initialize`; or a failed start `{version:1, launchId, pid, error:{code, detail}}` |
| `<profile>.log`, `<profile>.log.1` | 0600 | the bridge | method names, ids, sizes, the agent's stderr (prompt text cut out); 5 MiB with one rotation |

The token is 32 random bytes in hex. It lives in the discovery file and in the mod's memory only: never in a log, a
snapshot or `shared.json`.

### 13.2 Bridge lifetime (`sys/assistant-bridge.js`, `bin/acp-bridge.mjs`)

- **Programs.** `node` and `hermes` are looked up on `PATH`, then in `~/.local/bin`, `/opt/homebrew/bin` and
  `/usr/local/bin`, then through the login shell's `command -v`, and run by absolute path (Herdr's own `PATH` may lack
  them, S5). Herdr's pid is `$PPID` of `/bin/sh -c 'echo "$PPID"'`.
- **Launch.** `hc run --bg --json --no-parent --no-notify --cwd <folder> --label lazuli.assistant.v2=<profile> -- <node>
  <H>/mods/lazuli/bin/acp-bridge.mjs …` passes v2 paths, a random launch receipt, and hashes of the observed discovery
  files (not their authentication tokens). The manager revalidates the folder generation immediately before `hc run`;
  if it changes during launch (including A→B→A), only that invocation's returned terminal address can be stopped.
  No address means no guessed cleanup. The Herdr process carries `HC_TERMINAL_ID`: without `--no-parent --no-notify`
  the bridge's terminal would get a parent and hc would type notes into it (S8). The agent
  argv is `<abs hermes> -p <profile> acp`, `-p` also for `default` so `hermes profile use` never changes which profile a
  bridge serves; with `assistant.debugAgent` set it is `debugAgent ++ ["-p", <profile>, "acp"]`.
- **Reservation and migration.** Before starting an agent the bridge takes a nonblocking exclusive kernel lock
  (Darwin `O_EXLOCK`, or `flock` elsewhere), then checks the receipts against the launch snapshot. A disappeared
  record is safe; a changed existing receipt, lock contention, or any read/lock error refuses launch. The
  bridge holds the lock through publication and final discovery cleanup; the agent never inherits the descriptor.
  The manager only reads; a crash releases the lock and can leave stale discovery for the next holder. Pre-v2
  discovery and terminal labels are read-only migration inputs; the old binary cannot write to v2. Replacement
  is refused while a legacy record is unreadable, malformed, or its PID cannot be confirmed gone, or a legacy
  terminal is still live (including pre-publication startup). Migration assumes only one active mod version per
  Herdr home; running an older mod concurrently cannot be coordinated by the v2 lock.
- **Start.** The bridge spawns the agent in its own process group (cwd = folder, `PATH` extended as for
  `run-agent.mjs`, with no empty entry when the bridge has no `PATH`: `acp-wire.agentPath`), sends `initialize` once
  (protocol 1, client `fs` and `terminal` capabilities off, `clientInfo`
  lazuli) and keeps the answer for every `hello`. No answer in 40 s is `init-timeout`. The mod polls the discovery file
  every 100 ms for up to 45 s (S9: cold start 0.6–1.6 s; `initialize` may refresh the provider login over the network).
  A fast refusal can finish before it appears in the live terminal list. The manager checks the finished inventory
  for its exact `hc run` address; an unavailable listing or a missing row is not proof of exit.
  The elapsed 45-second budget includes launch, discovery and terminal lookups; late lookup results cannot change the
  outcome. If `hc run` itself returns late, only its own receipt is cleaned up.
- **Reuse.** A discovery is reused when its `profile`, `cwd`, `herdrPid` and agent `argv` match and an authenticated
  `hello` arrives within 5 s. A launch that cannot reuse a bridge of this folder, profile and Herdr (no `hello` or
  a different agent argv) requests authenticated shutdown unless the process is already confirmed gone. An ACK is
  not exit: only confirmed absence permits retirement and replacement. An inconclusive result leaves discovery alone
  and shows a retryable error; the mod also remembers the discovery if an older bridge unlinks it early. A live bridge
  of the profile for another folder holds the profile's lock, so a bridge launched beside it would exit at once (la-c15:
  the folder changed in `settings.json` and a reload, with no client of the old bridge connected, showed "Couldn't start
  Hermes"). It is never attached: one of this Herdr is retired first in the same way (authenticated shutdown, confirmed
  exit; otherwise the retryable `bridge-elsewhere` and no launch); another Herdr's (either folder) is left alone and
  nothing starts (`bridge-foreign`). A reuse-only connection never shuts down the bridge. The read helper distinguishes
  ENOENT from an unreadable file; an uncertain
  or invalid discovery cannot authorize replacement. Finished terminals are reaped without signalling any live
  terminal from a saved PID. An orphan after ungraceful bridge death is deliberately not signalled.
  Every attachment, queued transport write and stream callback belongs to one folder generation. `hello` must
  identify the discovery's profile, folder, PID and start time. Switching folders invalidates the old generation
  before cleanup and retains a recovering bridge's discovery for authenticated shutdown. The new folder has its
  own open promise, including after A→B→A; it never inherits the old generation's result or stream.
  A `replaced` subscriber relinquishes shutdown authority and does not reattach to the successor's instance.
  Stopping the status service retires pending history loads; their chats remain stale until reloaded.
- **Ends.** Idle: 30 minutes with no `send` and no agent line, no prompt in flight and no agent request open (pings and
  stream connects do not count). Herdr: `process.kill(herdrPid, 0)` every second. SIGHUP (`hc kill`), SIGTERM, SIGINT
  or Herdr gone take the fast path: `session/cancel` for running sessions without waiting, SIGTERM to the owned agent
  group, SIGKILL 300 ms later if the agent child has not exited, discovery removed, exit within 400 ms.
  `{op:"shutdown"}` (an authenticated folder or agent change) cancels running sessions and waits up to 3 s, then
  SIGTERM and, if the child has not exited, SIGKILL 2 s later (5 s after a cancel): out within 3 s with nothing
  running, 11 s with a turn. An unexpected agent exit sends `agent-exit` and `bye`, then exit 1; nothing respawns it.
  Ready discovery stays readable until the bridge is about to exit, even after it stops accepting connections.
  Once the agent child exits, the bridge stops signalling its group even if descendants remain: the child no longer
  pins that group ID, and no process-instance-bound group signal is available.
- **Reaper.** A bridge that ended leaves its terminal behind until `hc rm` (S5). Herdr's `terminals()` lists live
  terminals only, and the JSON of `hc ls --all --json` carries no labels and no pids, so a profile's bridge
  terminals, finished ones included, are listed with hc's own filter: `hc ls --all --json --label
  lazuli.assistant.v2=<profile>` (plus the legacy `lazuli.assistant=<profile>`). Every 60 s the service removes the
  finished ones for known profiles; replacing a profile's bridge also reaps its finished terminals.
- **Log.** Hermes logs the first 100 characters of every prompt to stderr (`acp_adapter/server.py:1383`) and the first
  80 again in a `conversation turn: … msg='…'` line (`agent/turn_context.py:213-217`); the bridge rewrites the first to
  its session id and `[<n> chars]` and the second to `msg=[redacted]`.
- **Agent errors.** Hermes ends a failed turn (a model the provider rejects, an expired login) with `stop_reason:
  "end_turn"` and no message; the cause goes to stderr only (`acp_adapter/server.py:1557-1562`, 1593-1672). After
  `initialize`, each stderr line that is Hermes's `❌ …` line or an `[ERROR]`/`[CRITICAL]` log record (never a
  prompt-preview or turn line) also becomes an `agent-error {text}` record (at most 1,000 characters) with its own seq,
  kept in the replay ring like an agent line. Written while a turn runs, it belongs to every running turn, so a
  `turns: true` stream gets it with that turn's records.
- **First lines.** A connection's first line must bring a valid token: within 5 s, and within its first 64 KiB
  (`PRE_AUTH_BYTES`) unless those bytes start `{"op":…,"token":"<the token>"` (a long `send` line; lazuli's lines put
  the token second). A refused or answered connection is destroyed 1 s after its reply, so a client that never closes
  its side leaves no half-open socket.

### 13.3 Connection (`sys/acp-client.js`)

- **Two channels.** One stream connection per profile (first line `{op:"stream", token, since, client, turns?}`, then
  `hello` and every agent line as a numbered record) and one short connection per message (`{op:"send", token, msg}` →
  `{ok}`). The client never writes on the stream after its first line.
- **Host limits (S8).** A Herdr `net` read that waits 30 s fails with "os error 35": the bridge pings after 10 s of
  silence, the client reads again after such a failure and counts the stream lost after 3 in a row or at its end. One
  `net` write carries at most 1 MiB, so a longer line goes in pieces. At most 8 sends per profile at once and no timer
  per line or read (1,024 host tasks per runtime).
- **Promise-job drain.** Herdr's QuickJS scheduler drains promise jobs with a cap per entry point (its message: "stopped
  draining promise jobs after …: a continuation is queueing work faster than it completes. The remaining jobs run at the
  next entry point"). One 1 MiB read can hold thousands of records (a `session/load` of the 2,100-tool `burst` session
  is 4,220), and handling them one after another without a host call stopped the read loop: in the live window it
  handled no further line after about 1 s of such work (2,500–2,840 lines), for minutes, so the load never ended,
  every later answer (`session/list` included) timed out with `bridge-timeout`, and only a mod reload helped. The loop
  now gives the host a turn (`cx.sleep(1)`) after every 64 lines or 20 ms of work.
- **Recovery.** A dropped stream whose bridge still runs reconnects with `since` = the last record held and gets what
  it missed (the ring keeps 4,000 records or 8 MiB; older is `gap`, and the chats reload); where a stream stopped is
  kept across a stop of the service, and a record seen already is not applied again. A client with no record of a
  bridge (after a mod reload) opens with `turns: true`: `hello.running[]` gives each running prompt's start seq and
  blocks, and the bridge sends that session's records since the turn began (outside its history loads), so a turn that
  began before the reload shows once and whole. `hello.pending` restores open approval cards. A request the service
  holds in flight that `hello.running` no longer lists (its answer went while no stream listened: a reopen past the
  ring, a bridge that came back) fails, and its chat turns stale and loads again (the selected one at once), so no chat
  shows "Responding" for a turn that ended. A bridge that is gone fails the chats' open requests and shows a banner with
  Retry.
- **Stalls.** A stream whose loop handled no line for 30 s (pings come after 10 s of silence), a `session/list`
  unanswered within 30 s, and a `session/load` unanswered within 45 s all reopen the stream (`since` = the last record
  held): the waiting requests end `disconnected`, the bridge replays what was missed, and a load tries once more after
  that replay was handled (`caughtUp`), on the bridge still running (no launch). A bridge that does not answer the new
  stream turns the group to `error` (the banner's Retry). A list that fails keeps the rows read before, so neither the
  rows nor the selection go. A reopen is shared as a connect that may not launch; a caller that wants a bridge waits for
  it and then launches when it found none.

### 13.4 Service (`sys/assistant.js`)

- **Where it runs.** Module state shared by every copy, run by the always-shown `status` copy
  (`views/shell/services.js`). Views call it inside `cx.spawn` and read `snapshot()` in render. Every `net`, `exec` and
  `hc` call is behind `checking()`. Changes redraw the copies through the store `assistant` (`snapshot: false`), at most
  one `store.set` per 80 ms.
- **`start(cx)`** does nothing on a herdr-relay device (it probes `true` as the views' relay gate does: the Assistant is
  desktop-only). Elsewhere it launches nothing and runs no `hermes`: it reconnects to running bridges of the current
  folder and Herdr (the reuse rule), so notices keep coming after a reload while another screen shows, and fails what
  the chats of a profile left without a bridge still hold in flight (they turn stale). Its one-second tick expires
  approval cards, reopens a stream that handled no line for 30 s (13.3 Stalls), removes finished bridge terminals every
  60 s, rereads the folder's files every 10 s and the list every 30 s while the screen shows, and follows a folder
  changed in `settings.json` by hand. The folder's files (for @) come from one `find` whose output `head -c` cuts at
  512 KiB, so `find` stops there; a walk never starts while another runs (a forced one follows it).
- **`open(cx)`**, called by a local Assistant view on every show (idempotent): the folder (unset → `no-folder`; not a
  folder on disk → `folder-missing`); once per start `hermes acp --check` (with `debugAgent`, `debugAgent ++ ["acp",
  "--check"]`; not found or not executable → `hermes-missing` with where it looked; a non-zero exit →
  `hermes-check-failed` with its output and code); the profiles and the list; the `default` bridge; the remembered
  selection. A new bridge starts only after these gates passed. `recheck(cx)` (the gates' Retry) runs them again.
- **List.** Profiles: `default` (`~/.hermes`) and each folder of `~/.hermes/profiles` with a valid name
  (`^[a-z0-9][a-z0-9_-]{0,63}$`). Rows: `/usr/bin/sqlite3 -readonly -json <state.db> SESSIONS_SQL` per profile that has
  a database: Hermes's own listing (`source='acp'`, at least one message, not archived, compression children folded into
  their first row). The cwd filter runs in JS: a row belongs to the folder when its cwd, normalized as Hermes does
  (`~` expanded, `.` and `..` resolved, no trailing `/`), is the folder's path, or when both resolve to the same
  physical folder (`/bin/sh` with `cd -P` and `pwd -P`: symlinks and macOS firmlinks, so `/tmp/x` and `/private/tmp/x`
  match; each distinct path resolved once per run, one that does not resolve asked again). Empty output is no rows.
  Error `(14)` with no `-wal` file (Hermes removed it on a clean exit) is retried once on `file:<db>?immutable=1`; a
  missing column or table is `schema`. A profile whose query fails lists through its connected bridge with
  `session/list {cwd, cursor}` (no stats), as every profile does with `debugAgent` set. Chats made in this run show
  until the database has them. The list is read again about a second after each turn. The shared key
  `lazuli.assistant.ui` keeps the selection and the collapsed groups (DESIGN E5): reset for another folder, the
  selection cleared once its row is gone.
- **Hermes local sessions.** A gateway Hermes answers `session/new` and `session/fork` with an id `local-<64 hex>` and
  stores the thread as `source='local'`, its cwd in the `cwd` column (AT-25); SESSIONS_SQL does not read it. The service
  records each such id it was answered with, with that bridge's profile and folder, in the shared key
  `lazuli.assistant.owned` (at most 200, the newest made kept; kept across folder changes). Each listing then reads
  exactly those ids of that profile and folder with a second query on the same database target (`ownedSessionsSql`:
  `source='local'`, at least one message, archived ones flagged; only columns Hermes 0.17.0 has), so the chat lists,
  stays selected and loads after a reload with its database usage and cost. A local id shows only when owned in that
  profile and folder, not archived, and its cwd is in the folder: another editor's, the CLI's, another folder's or
  profile's local chats never show (from the database or `session/list`) and never count against the listing's
  `LIMIT 1000`. With nothing owned a database is read with the one ACP query, as before. A compressed chat lists its
  first row, as ACP rows do.
- **Remembered local selection after a reload.** A reload starts from empty service state: the status copy's `start`
  reconnects to the running bridge (whose hello restores the running turn), then lists every profile; a view's `open`
  shares that list, then restores the selection. On la-c12 (AT-25) a reload during a new chat's first turn lost the
  selection: the only writers that clear it are that full list's `pruneUi` and a folder change (none), and with
  nothing of the run standing in for the chat any more (`local` is per run), the list read during the turn had no row
  for it, so `pruneUi` cleared it and the restore found nothing to load. The service now passes the remembered
  selection, when it is a local id owned in that profile and folder and nothing of this run holds it, as a stand-in
  row (`heldSelection`): it stays selected through an inventory that is still out, failed or lacks its row, and the
  restore loads it with no select call (once, and only while it is still the selection: a newer one wins). The stand-in
  gives way to the database row, and goes with the selection when the rows rule it out (archived, or its cwd in
  another folder) or a load answers without `models` (no such session; its record is dropped as well).
- **Chats.** `+` makes `session/new` (an unused empty chat of that profile made in this run is reused); selecting runs
  `session/load`, whose history replays into the chat; Fork runs `session/fork`. Text goes as described in 13.6. Stop
  sends `session/cancel` and pauses the chips. An approval answer is `{outcome:{outcome:"selected", optionId}}`, one per
  request (a second click while the first is sent gets its result and sends nothing), refused
  with `too-late` after the card's 60 s. A card still open when its turn ends closes as `expired` when that is within
  2 s of its deadline or later (Hermes gave up at its own 60 s; its clock starts a moment before the bridge's receive
  time), else as `cancelled`; a late answer to either is refused with `too-late`. The model changes with
  `session/set_model`, refused with `busy` while a turn runs. A folder change with a turn running returns `busy` until
  confirmed; then each bridge gets `shutdown`, the folder is saved, and the screen opens there.
- **Mid-turn loads.** Hermes saves a turn only when it ends, so a `session/load` while a turn runs (a selection, a
  reload) replays a history without it. The service keeps each running turn's events (the prompts sent, every update
  it streamed, a steer's answer as its notice; at most 4,000) and applies them again after the load, the prompts only
  as their user items: the turn shows once and whole. A turn too long to keep marks the chat stale (it reloads once
  idle); a turn that ended during the load loads the chat once more.
- **No load under a gateway turn.** A Hermes gateway chat (a local id) is not loaded while a prompt of it waits for
  its answer (in the service's view: the bridge's hello lists it as running, or this run sent it). On la-c13 (AT-25) a
  reload just as such a turn finished loaded it: the prompt was never answered, so the chat kept Responding, and the
  replayed history already held the finished pair, which the turn's events then added again. The gateway's load
  installs a fresh snapshot whose event watermark can pass over the turn's `message.complete`
  (`acp_adapter/gateway_server.py` `_adopt`, `_events`), and its history can hold the running turn; the observed run
  fits that, but no Hermes-side log shows which. Instead such a chat shows the running turn alone, live, from its
  events (a chat already loaded keeps its transcript), and loads once its answer comes, so the history replays once.
  Only that answer ends the turn: without it the chat stays running (a Stop sends `session/cancel` and waits for the
  answer too), with no timeout. Earlier turns of such a chat show only once the running one ended.
- **Agent errors and failed turns.** An `agent-error` record is not tied to a session: every chat of that profile gets
  it, and a chat whose turn runs keeps the newest one. A prompt's turn that ends `end_turn` with no assistant text, no
  tool item and no approval card gets a `failed` notice with that text, or "Hermes ended the turn without a reply; see
  the bridge log" when there was none (K5 rule 11; an error line arriving within 5 s after still fills it in), and a
  `failed` notification instead of `done`.
- **Titles.** A row and the chat header show the agent's title: the newest `session_info_update` of this run, else the
  list row's (Hermes's database or `session/list`). A session made this run shows its first prompt's line only until
  the agent's title is known, so after a bridge reconnect the row keeps the agent's title. The header takes the list's
  title when the chat has none yet (a load sends none) or only that stand-in; a title the agent sent stays.
- **Folder form.** The macOS folder picker reports a folder under `/tmp` or `/var` by its firmlink target
  (`/private/tmp/x` for `/tmp/x`). `setFolder` keeps the short form when both forms resolve to the same folder, so the
  bridges' `--cwd`, Hermes's session cwds and the settings agree; its result carries the folder as kept (`path`).
- **Notices** `{id, kind: permission|done|failed, key, title, body, at}`: an approval request, a prompt that ended (not
  cancelled) with a reply, and a failed prompt, a reply-less turn or a lost bridge with a prompt in flight. None while
  the screen shows that chat in the active window. `sys/notify.js` delivers them (§7) with the target
  `assistant:<profile>:<session>`.

### 13.5 Views, commands, settings

- **Views** (§3): `assistant-list` (groups, rows with running spinner or "Needs you", Fork on hover, the new-chat
  profile picker with Nod Planned), `assistant` (header with title, profile, running time, model menu and Fork; bridge
  banner; virtualized transcript, where a single line break in Hermes's text is kept and a long error detail is clamped
  with Show all; plan strip; composer; or a gate), `assistant-info` (model, mode, context, last turn,
  totals with API calls, cost and cost status), and `files` with `scope:"assistant"`: rooted at the folder whatever has
  focus, refreshed while `assistant-files` shows, a click opens the file with `filetabs.open` in the active space and
  shows the work view (no active space: a notice), and a file row's Attach runs `lazuli.assistant:attach:<rel>`.
- **Menus.** The approval card's More, the header's model menu and the list's new-chat picker are gpui-base `Popover`s
  whose triggers come from `views/assistant/menu.js`. A Popover opens from a mouse-down listener around its trigger, and
  the kit's Button and IconButton stop mouse-down (so a press on a control never drags the window): those triggers
  draw like the kit's buttons without that listener.
- **Relay gate.** The views probe the host as Home does (`views/apps/snapshot.js`); on a herdr-relay device they draw
  the desktop-only notice and never call `open`. Copies with `props.preview` or `props.sample` draw the canned states of
  `views/assistant/sample.js` (the approved prototype's).
- **Commands.** `lazuli.go:assistant` (⌥⌘4, owner `status`) runs `showCenter("assistant")`.
  `lazuli.target:assistant:<profile>:<session>` (a notification or palette row) shows the screen with that chat
  selected; the profile must be a Hermes profile name and the session `^[0-9a-f-]{36}$`. `lazuli.assistant:<verb>`
  reaches every copy's `command()`: `new[:<profile>]`, `select:<profile>/<session>`, `focus`, `stop`,
  `attach:<rel path>`, `allow`, `deny`, `send:<text>` (test hook) and `sample:<name>` (preview copies). `allow` and
  `deny` answer the selected chat's newest pending card, else its newest expired or cancelled one, which the service
  refuses with the "too late" notice.
- **Composer keys** are key bindings, not key-down handlers: GPUI runs the focused textarea's own bindings (Enter: a
  new line) before any key-down listener. The composer binds its actions once with `cx.bind_keys` in a key context its
  frame declares above the textarea (`lz_assistant_composer`, or `lz_assistant_list` while the @ or / list is open), as
  Herdr's chat mod does: Enter sends (steers while a turn runs), ⌥Enter and ⌘Enter queue a chip, and in the list
  Up/Down move, Tab/Enter take a row and Escape closes it. ⇧Enter keeps the textarea's new line. ⌘Enter exists because
  the Korean input source takes ⌥Enter. With an input method composing, Enter first commits the syllable, then sends
  the whole text. The `lazuli.key:<keystroke>` test hook reaches the same actions.
- **Elsewhere.** Sidebar item `assistant` (pinned by default; a count of chats waiting on an approval, else a working
  dot while a turn runs); palette rows "Assistant" and the folder's chats; the settings view's Assistant section (the
  folder, with the confirm of a folder change while a turn runs). Settings: `assistant.folder` (absolute path or null)
  and `assistant.debugAgent` (an argv or null; left out of the README).

### 13.6 Hermes ACP mapping and limits

| lazuli | ACP (Hermes 0.17.0) | Notes |
|---|---|---|
| bridge start | `initialize` | once per bridge, answer cached |
| "+" | `session/new {cwd, mcpServers: []}` | |
| open a chat | `session/load {sessionId, cwd, mcpServers: []}` | the history replays as `session/update`s; an unknown id answers `{}` (no `models`): `not-found`. `session/resume` is never used |
| Fork | `session/fork` | an unknown source answers `sessionId: ""`: `not-found` |
| model menu, `/model x` | `session/set_model` | not while a turn runs |
| send while idle | `session/prompt` with a `text` block and one `resource_link` (`file://…`) per attachment | |
| Enter while a turn runs | `session/prompt` with `/steer <text>` | attachments become `@path` text: Hermes drops a running prompt's attachments, and they turn slash handling off |
| ⌥Enter or ⌘Enter, typed `/queue x` | none until the turn ends, then `session/prompt` | chips are lazuli's: Hermes's own `/queue` cannot remove or pause |
| other advertised `/command` | `session/prompt` with the text | Hermes answers `help`, `model`, `tools`, `context`, `reset`, `compact`, `version` itself; after `/reset` or `/compact` the chat reloads, then the queue head goes (unless paused) and the list is read again |
| Stop | `session/cancel` | the turn ends `cancelled`; chips pause |
| approval card | answer to `session/request_permission` | buttons by option id: `allow_once`, `allow_always`, `deny`; the rest (`allow_session`, `deny_always`) under More |
| list fallback | `session/list {cwd, cursor}` | |

- **Steer answers.** Hermes answers `/steer` with one chunk; the adapter's anchored patterns (`⏩ Steer queued for the
  active turn: …`, `No active turn — queued for the next turn. (n queued)`, `⚠️ Steer failed: …`, `Usage: /steer
  <guidance>`) turn it into a notice; a reply that merely starts with "Queued" is not one.
- **Diffs** show only while a conversation is live: Hermes's history replay has no diff and no tool timing.
- **Failed turns.** Hermes reports a turn that failed before any reply (a model the provider rejects, an expired login)
  only on stderr and ends it `end_turn`: lazuli shows it from the `agent-error` records (13.2, 13.4). An error Hermes
  logs without the `❌` mark or an `[ERROR]`/`[CRITICAL]` level is not recognized and reads "without a reply".
- **Approvals.** Hermes waits 60 s and sends no deadline, so the card counts down from the bridge's receive time.
  Edit approvals (`toolCallId` `edit-approval-…`) carry the diff and two options, `allow_once` and `deny`.
- **Database.** `state.db` is Hermes's private schema, read with Hermes 0.17.0's own query; another version may fail it
  (`schema`), and the list then falls back to `session/list` without token and cost columns. Totals of a session Hermes
  compressed may count only part of its history. lazuli never writes under `~/.hermes`; Hermes itself writes its
  sessions there and may refresh its provider login during `initialize` (S9).
- **Caps** (CONTRACTS `assistant-chat.js`): 2,000 transcript items, 400,000 characters per message, 20,000 per tool
  text; a longer message to send is refused `too-long`. The @ list holds at most 2,000 files to depth 8, without
  pictures, hidden entries, `node_modules`, virtual environments or `__pycache__`.

### 13.7 Fake agent and tests

`tests/fixtures/fake-acp-agent.mjs` speaks ACP over stdio like Hermes 0.17.0, from the shapes recorded in S9
(`tests/fixtures/acp/hermes-0.17.0.json`), so the bridge, the service and the views run without a model; the first
word of a prompt picks its behavior (CONTRACTS "Fake ACP agent"). Live checks point `assistant.debugAgent` at it
(`docs/TESTING.md`, Assistant). The unit tests are in §9.