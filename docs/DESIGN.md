# lazuli: design decisions

Status: approved by the owner on 2026-11-19. This file records **what** the redesign must do. The module structure,
contracts and task split come from the architect design that follows it.

lazuli replaces `lstack-herdr` (a generated fork of cockpit 0.38.5 plus hand-written additions) with one hand-written
Herdr app layout that has no cockpit dependency. Section IDs (A1, B4, …) are stable; refer to them in reviews.

## Platform facts the design relies on

Herdr app 0.1.16, macOS arm64. `H` = `~/.config/herdr-app`.

| Fact | Evidence |
|---|---|
| A mod can be a workspace tab's only pane: `tab.new {name?, space?, mod, props?, focus?}`; tabs, splits and props survive restart, JS state does not. | `H/AGENTS.md:580-595` |
| `pane.split {direction, pane?, argv? \| mod?, props?}`, `pane.zoom`, `pane.close`; no pane hide. | `H/AGENTS.md:596-615` |
| Mods return a declarative native GPUI element tree; no DOM, CSS, iframe or webview. JS engine is QuickJS. | `H/AGENTS.md:27-47`; `rquickjs` symbols in the Herdr binary |
| `TextView.markdown/html` render rich text; HTML has no CSS. | `H/gpui-kit.d.ts:20737-20747` |
| `image(path)` draws PNG/JPEG/SVG from a path inside the app home only; no bytes/data-URI source. | `H/gpui-kit.d.ts:20301-20318`; binary error strings |
| Native editor: `EditorState.new` + `Editor.new`, bundled grammars. | `H/gpui-kit.d.ts:21490-21525` |
| `exec(cmd,args,{cwd,on,timeout})` resolves after exit; 8 MiB output; ≤600 s. Long-lived processes must be started detached (`hc run --bg`, as `H/mods/task-browser/main.js:112`). | `H/herdr.d.ts:4-17`; `H/AGENTS.md:1101-1108` |
| `net.connect(host, port)` TCP client exists; a capability-gated `websocket` module exists (ws:// only). | `H/gpui-kit.d.ts:22205-22234` |
| `readTextFile` ≤1 MiB (remote via `on`); `writeTextFile(path, text, expected)` local only, refuses stale saves; `fs/promises` reads binary; writes allowed under the app home. | `H/herdr.d.ts:27-32`; `H/AGENTS.md:1113-1142` |
| `watchFolder(dir)` local only, ≤64 pending folders. | `H/AGENTS.md:1115-1131` |
| Keys: bind `<mod-folder>.<command>` in `keys.json`; the shown mod receives it via `nextCommand()`. Built-ins bind as `{command, args}`. | `H/AGENTS.md:508-540` |
| `notify()` draws an in-app toast only (click runs a command); `setBadge(text)` sets the Dock badge. | `H/AGENTS.md:1090-1091,1132-1135` |
| Themes: layout root `"theme": {"light": "...", "dark": "..."}`; `themes/<name>.json` = `{background, foreground, selection, cursor?, ansi[16], colors?}`; `theme()` names: background, canvas, chrome, surface, popover, raised, hover, selected, border, input, foreground, muted, dim, accent, accent_foreground, solid, solid_foreground, selection, working, blocked, done, idle, unknown, ansi0..15. | `H/AGENTS.md:319-338,1066-1072` |
| `cx.notify()` redraws the whole window; `close()` gets ≤250 ms. | `H/AGENTS.md:990-1003` |

Measured on this Mac (research prototypes in `/tmp`, deleted):

- Headless Chrome 157 over CDP: click → next screencast frame median 6–11 ms; 60 fps on light pages; `Input.insertText` delivers Hangul; Chrome's built-in PDF viewer works headless.
- PDF to JPEG q90 at 1600 px, PDFKit compiled helper: 43–100 ms per spawned call, 11–59 ms per page as a persistent daemon (needs an `autoreleasepool` per render). PNG encoding is the slow part for every engine; use JPEG.

## A. Scope

**A1. Remove cockpit entirely.** No cockpit mod, CLI, hub connection, `cockpit.json` read, Sync, `sync.mjs` or anchor
hooks. Uninstalling cockpit itself is documented in the README only; this project never removes it.

**A2. Removed features.** Runbook (center view and side panel), Documents (`show` panel), Meetings, Monitor, Mail, and
every trace of them in Home, the palette, the sidebar badges and keys.

**A3. Rebuilt with the same function and a new design.** The current fork is the behavioral reference
(`mods/lstack-herdr-cockpit/`, `mods/lstack-herdr/`):

| Feature | Reference source | Function to keep |
|---|---|---|
| Home | `home.js`, `fleet.js` | stage board of agents/PRs, next action, app summaries (Inbox, To-do, Routines), recent events, spend, restore-pending terminals |
| Inbox | `inbox.js` | grouped reviews, PRs and CI; details (CI log, failed tests, review threads, PR files); actions incl. start plan |
| To-do | `todo.js` | add, edit, check, reorder, delete, undo, open linked issue/PR/URL |
| Routines | `routines.js` | schedule, run, stop agent or shell routines; output, cost, history; settings; worktrees |
| Review panel | `review.js`, `diff.js` | uncommitted / branch / PR diff, line comments sent to the agent, AI walkthrough |
| Files panel | `lh-files.js`, `lh-files-ops.js` | folder tree, git marks, new file/folder, rename, delete with confirm; opens files in center tabs (B1) |
| Changes panel | Herdr's shipped `changes` mod | used as is |
| Call tree and run view | `lh-tree-*.js`, `lh-run.js`, `lh-scan.mjs`, `lh-transcript.js`, `omp/` | unchanged behavior, new UI |
| Session restore | `lh-resume.js`, `lh-resume-tools.js` | unchanged behavior |
| Sidebar, bell, status bar | `sidebar.js`, `bell.js`, `status.js`, `agentsui.js` | pinned apps with badges, agents, machines/spaces/tabs/worktrees, attention bell, stage counts and contextual links |
| Palette | `palette.js` | commands, keys, layouts, spaces, tabs, agents, plus search (A4) |
| Queue | `queue.js` | per-terminal prompt queue: add, edit, reorder, remove, clear, send one or all |
| Recap | `recap.js`, `agentsui.js` | agents by stage, answer / recap / snooze / fork, weekly time |
| Keys | `status.js`, `fleet.js` | next-waiting, next blocked, next done, PR, ticket, agent view, panel toggles |

**A4. Data sources.**
- Inbox, PR and CI data: `gh` only (GitHub). No Linear or other tracker.
- Ticket key (⌘L) and ticket fields: the ticket link found in the PR body or branch name.
- Home stage board: Herdr agent state joined with `gh` PR/CI data.
- Home spend: usage recorded in OMP, Claude Code and Codex transcripts. OMP records carry USD; Claude Code and Codex
  carry tokens only, converted with a per-model price table in the code (`core/pricing.js`, updated by hand when prices
  change). Models missing from the table show tokens, marked unpriced.
- Palette search: commands, layouts, spaces, tabs, agents, PRs, to-dos, routines, past sessions (OMP, Claude Code, Codex).

**A5. AI features** (Recap summaries, Review walkthrough, agent routines, Inbox start plan) run a headless agent. The
default command is `omp`; the command is configurable in settings (C3).

**A6. Routines** run only while Herdr runs (in-mod scheduler). After a restart, each routine that missed runs executes
once if the latest missed time is within its `catch-up` window (cockpit's field; default 12 h); later than that, a
"missed" record is written instead of a run.

**A7. Restore.** ⌥⌘R and Home's "lost agents" become part of lazuli session restore: Home lists terminals whose
automatic restore failed or is pending; ⌥⌘R retries all of them.

**A8. System notifications.** While the Herdr window is not active, notifications go through `terminal-notifier`
(installed with Homebrew); clicking one focuses the agent (`herdr-app do agent.focus`). If it does not work on this
macOS, fall back to the in-app toast plus `setBadge`. While the window is active, use `notify()`.

**A9. Migration (runs once, never deletes sources).**
- Copy `~/.config/cockpit/todo.md`, `~/.config/cockpit/routines/*.md`, the sidebar pins (from cockpit's config) and the
  pending queue into `H/data/lazuli/`. File formats stay compatible with cockpit's so the copies work unchanged.
- Rewrite the terminal label `lstack-herdr.resume` to `lazuli.resume` on terminals that have it.
- Delete `~/.cache/lstack-herdr`.
- No code reads old names after migration.

## B. File viewer

**B1. Placement.** Files open as Herdr workspace tabs in the center (`tab.new` with the lazuli mod). The right Files
panel is only the folder tree; clicking a file opens it in a center tab.

**B2. Tab rules.**
- Single click opens a preview tab: one per space, reused, name prefixed with `◦`. Editing or a double click pins it.
- A file already open in the space focuses its tab instead of opening another.
- Tabs open in the space of the pane the Files tree follows, focused.
- Tab name is the file name; `●` prefix while there are unsaved edits.
- A preview tab that switches files keeps its current file across restart (the mod persists it per tab).

**B3. Modes.** Edit / Split / Preview, cycled by ⌘⇧V.

| File | Default | Available |
|---|---|---|
| `.md`, `.markdown` | Split | Edit, Split, Preview |
| `.html`, `.htm` | Preview | Edit, Split, Preview |
| `.pdf` | Preview | Preview (read-only) |
| `.svg` | Split | Edit, Split, Preview |
| PNG, JPEG, GIF, WebP (formats Herdr draws) | Preview | Preview, with zoom |
| other text | Edit | Edit |
| binary / undecodable | info card | size, type, "Open in default app" |

**B4. Editing behavior** carried over from the current Files editor:
- Saving when the file changed on disk asks: reload or overwrite. If the disk version is no longer text (binary or
  undecodable), it asks reload or "save a copy" instead: the edits go to a new sibling file, because a non-text file
  can't be replaced conditionally (review fix).
- With no unsaved edits, a file changed on disk (e.g. by an agent) reloads by itself.
- Files over 400,000 characters, NUL-containing text, non-writable files and remote files open read-only (truncated
  where too large).

**B5. Unsaved drafts.** While dirty, the buffer is saved as a draft under `H/data/lazuli/drafts/` every second.
Reopening the file shows a "recovered unsaved edits" banner (restore / discard). A save or discard deletes the draft.

**B6. Markdown preview.** A native renderer: `marked` (MIT) parses; lazuli draws headings, lists, tables, quotes, code
blocks (highlighted with Herdr's editor grammars) and local images (copied into the app home cache for `image()`), in
theme colors. It follows the buffer as you type. A "View in Chrome" button opens the HTML viewer (B7) on a rendered
page with mermaid and math; that view shows the saved file only.

**B7. HTML viewer.**
- The HTML tab gets a terminal pane running lazuli's Node viewer, which drives headless Chrome over CDP directly
  (screencast frames drawn with Kitty graphics; mouse, wheel, keys, paste and `Input.insertText` forwarded). Modeled on
  `H/bin/herdr-browser-view`, without agent-browser.
- Split: editor pane left, viewer pane right. Preview: the viewer pane zoomed to the whole tab. Edit: the viewer pane
  closed; reopening shows it again within about a second.
- Only the saved file is shown. The page reloads after each save, keeping the scroll position.
- Pages are served by a loopback HTTP server (127.0.0.1, random port) so module scripts and `fetch()` work. Root: the
  git top-level, else the file's folder. It serves disk content only, and never a path with a dot-segment (`.git`,
  `.env*` and any other name starting with `.`): those answer 404 (review fix: a previewed page must not read
  repository secrets). A file inside a dot-folder (e.g. `.github/x.md`) is served with its own folder as the root; a
  file whose own name starts with `.` is not served and the viewer says so.
- The viewer's top line: file path, reload, open in browser, console error count.

**B8. Chrome policy.**
- One shared headless Chrome; one Chrome tab per HTML tab; it exits 5 minutes after the last HTML tab closes.
- Separate profile at `~/.cache/lazuli/chrome-profile`. Network: requests to anything but the viewer's own loopback
  server are blocked by default (every resource type through CDP Fetch, service workers and out-of-process frames
  included; WebSockets and shared-worker requests refused by the server's CSP); Markdown pages may also load the pinned
  mermaid/KaTeX files. The viewer's top line shows how many were blocked and an "Allow network" toggle (Ctrl+N) that
  allows them for that tab until it closes, reloading the page (review fix). Not covered: DNS prefetch/preconnect and
  WebRTC STUN.
- In-page anchors and local HTML navigate inside the viewer; an external http(s) link opens in the default browser
  only when the person clicked it in the viewer. A navigation the page starts by itself (script, meta refresh,
  redirect) to an external URL is blocked and noted in the top line instead (review fix).
- Browser lookup: Google Chrome → Chromium → Microsoft Edge → Brave. With none: static `TextView.html` plus "Open in
  browser".

**B9. PDF viewer.**
- Renderer: a PDFKit Swift helper running as a loopback TCP daemon, writing JPEG q90 pages into the app home cache.
- The helper is compiled with `swiftc -O` into `~/.cache/lazuli/bin/` when the lazuli layout starts (Herdr start or
  layout switch) if it is missing or its source changed; in the background, without blocking the UI. A PDF opened
  before the build finishes shows "Preparing PDF renderer" and renders when ready.
- If the build fails (no Xcode tools): one toast, then render with `pdftocairo -jpeg` (no search, no links); without
  that, an "Open in Preview" button.
- Continuous vertical scroll; render visible pages ±2.
- Fixed zoom steps: fit width, 50, 75, 100, 125, 150, 200%.
- Page number jump; outline side panel toggle.
- Search with highlighted hits on the page and next/previous.
- Links: internal → page, external → default browser.
- No drag selection; "Copy page text" instead.
- Render cache capped at 300 MB, least recently used first. Every render goes to a unique file name.

**B10. Remote spaces.** Files are read-only; text and Markdown preview only. HTML and PDF previews are local only.

**B11. Quick open (⌘⇧O)**: fuzzy file search under the focused folder, opens per B2.

## C. Design and language

**C1. Theme.** New `themes/lazuli-light.json` and `themes/lazuli-dark.json`; the layout root sets
`"theme": {"light": "lazuli-light", "dark": "lazuli-dark"}`. Mods use `theme()` colors only.

**C2. Visual design.** Redesigned from scratch; no cockpit UI code is reused. Three directions are mocked up (Home and a
Markdown file tab in Split), each with its palette:

| Direction | Palette | Dark bg / text / accent / secondary | Light bg / text / accent |
|---|---|---|---|
| Calm and dense (Zed, Linear) | Lapis | `#0E1626` / `#E6ECF7` / `#5B8FE0` / `#D4A84B` | `#F6F8FC` / `#14213D` / `#26619C` |
| Information-dense IDE | Cobalt | `#0A1020` / `#E4EAF5` / `#4C93F0` / `#F2994A` | `#F5F7FB` / `#0F1B33` / `#1A5FC2` |
| Warm editorial | Denim | `#161B26` / `#E9E4D8` / `#8AA6DA` / `#D9895B` | `#F7F4EC` / `#1E2A44` / `#35528F` |

All text and accent pairs above measure ≥4.9:1 (WCAG AA).

**Chosen (2026-11-19): A · Lapis, calm and dense.** Reference screens and tokens: `docs/mockups/a-lapis/` (`tokens.json`
is the source for `themes/lazuli-*.json`). The lazuli logo (SVG) is drawn in this palette. UI font: Pretendard (Regular,
Medium, SemiBold, Bold OTF shipped in `mods/lazuli/fonts/`, SIL OFL 1.1; the layout root sets `"ui_font": "Pretendard"`).
Monospace font: D2Coding; terminals keep the font from the person's `settings.json`.

**C3. Language.** Korean and English. Default: the macOS system language (Korean → Korean, anything else → English).
Switch in lazuli's settings view and the palette command "Language / 언어"; applies immediately. AI-written text
(recaps, walkthroughs) follows the setting. Settings live in `H/data/lazuli/settings.json` (language, headless agent
command, and other lazuli settings). Product terms stay English in both (PR, CI, Diff).

**C4. Docs.** `README.md` in English, `README.ko.md` in Korean. Code comments and commit messages in English.

## D. Structure, keys, delivery

**D1. Naming.**

| Before | After |
|---|---|
| `mods/lstack-herdr`, `mods/lstack-herdr-cockpit` | `mods/lazuli` (one mod; views chosen by props) |
| `layouts/lstack-herdr.json` | `layouts/lazuli.json` |
| keys `layout:lstack-herdr`, actions `lstack-herdr-cockpit.*` | `layout:lazuli`, `lazuli.*` |
| `~/.cache/lstack-herdr` | `~/.cache/lazuli` |
| terminal label `lstack-herdr.resume` | `lazuli.resume` |
| OMP extension `lstack-herdr-tree.ts` | `lazuli-tree.ts` |

**D2. Keys** (section `layout:lazuli`).

| Key | Action |
|---|---|
| ⇧⌘P | palette |
| ⌥⌘0 | Home, or back to the work view |
| ⌥⌘1 / ⌥⌘2 / ⌥⌘3 | Inbox / To-do / Routines |
| ⌥⌘A | work view: panes ↔ focused agent |
| ⌥⌘B | side panel show/hide |
| ⌘1 / ⌘2 / ⌘3 / ⌘4 | panel Review / Files / Changes / call tree (pressing the shown tab's key closes the panel; closing never changes the center view) |
| ⌘⇧V | file tab mode: Edit → Split → Preview |
| ⌘⇧O | quick open |
| ⌘J / ⇧⌘J / ⇧⌘U | next waiting (an agent that needs you, else a finished one waiting for its next prompt, with a toast saying so) / next blocked (needs you only) / next done; with none, focus stays and a toast says so |
| ⌥⌘Q | prompt queue |
| ⌥⌘R | retry pending restores (A7) |
| ⌘R | recap |
| ⌘G / ⌘L | open focused agent's PR / ticket |

New keys were checked against the `global` section of the installed `keys.json`. ⌘1–⌘4 replace Herdr's global tab selection (`tab.select:1–4`) while this layout is shown; ⌘5–⌘9 still select tabs.

**D3. Layout.** Keep the current frame: left sidebar, top bar (tabs and bell), center stack (Home, Inbox, To-do,
Routines, work), work row (active tab or focused agent, right panel with Review, Files, Changes and call tree),
bottom status bar, floating queue. The right panel's default tab is Files.
- The activity rail sits at the right edge of the main area, outside the panel, and is visible on every center view.
  Clicking an icon from Home, Inbox, To-do or Routines switches the center to the work view and opens that panel tab.
- The top tab strip is Herdr's shipped `tabs` mod. The file-tab markers `●` (unsaved) and `◦` (preview) are plain text in
  the tab name.

**D4. herdr-relay.** Relay devices get read-only lazuli: Home, Inbox, To-do and Routines from snapshots the Mac writes
under `data/lazuli/`, the call tree, spend, and Markdown preview of file tabs already open. Actions (`gh`, `omp`, `sh`,
saving, opening tabs) are refused on devices, because a herdr-relay profile cannot enable them (herdr-relay
`docs/PROFILES.md` §1, §6; `docs/POLICY.md` §2.4). A policy profile for the `lazuli` folder ships in `relay/`, and the
README documents installing it. Extending herdr-relay itself is a separate, later project.

**D5. Delivery.**
- Work on branch `redesign/no-cockpit`. Every commit is confirmed with the owner first.
- After acceptance testing passes, back up the installed `lstack-herdr`, `lstack-herdr-cockpit`, layout and key
  section, then replace them, with a confirmation right before replacing.
- Rename the GitHub repository to `herdr-lazuli` (and the local folder) right before deployment, after confirmation.

**D6. Verification.**
- Pure logic under `node:test`: gh result mapping, routine scheduling, drafts, path handling, migration, i18n key
  completeness (every key exists in both languages).
- `herdr-app check` on the mod, then scenario checks in a live Herdr window with screenshots as evidence.
- herdr-relay with the shipped profile: the base screens render.

**D7. Notices.** cockpit notices are removed with the cockpit code. Notices stay or are added for anything reused or
shipped: the folder tree ported from Herdr's `files` mod (Apache-2.0), Lucide icons (ISC), `marked` (MIT), Pretendard
(SIL OFL 1.1, license file beside the fonts).

## Open items

- Development preview: `~/.config/herdr-app/mods/lazuli` is a symlink to this repository's `mods/lazuli` (owner approved
  2026-11-19); remove it before deployment replaces it with the real install.
- `terminal-notifier` on macOS 27 (A8): verify early; fallback is defined.
- Kitty graphics and SGR mouse in a Herdr terminal pane inside a mod tab (B7): verify early with a spike.
