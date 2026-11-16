# lstack-herdr

cockpit for the Herdr app, plus a live call tree of your agents' subagents, an editor in the Files panel, and session
restore for Claude Code, Codex and OMP.

![lstack-herdr](preview.png)

*The picture is the layout's schematic, the same one cockpit ships: it shows the frame with made-up counts, not the
call tree.*

## What it adds to cockpit

lstack-herdr is a layout for the [Herdr app](https://herdr.dev) built on [cockpit](https://github.com/quaresc/cockpit).
The layout is cockpit's, and its mod `lstack-herdr-cockpit` is generated from cockpit's mod: the same Home, Inbox,
Runbook, palette, queue and keys, with four additions.

- **Agent call tree (⌃⌘6).** A new side panel tab, after Changes. It shows who started whom: each OMP session as a
  root, its task subagents nested under it, and `hc` child terminals under the terminal that started them. A row
  shows the status, name, agent type, the task's first line and how long it ran; a click opens its task, shared
  context and result, and `기록 열기` opens the subagent's transcript, live and read-only. The `실행` view shows one run
  of one root as cards, with each agent's latest steps, cost and lifetime, and `창으로 크게 보기` opens it in its own
  window. The tab's button counts the space's running subagents, or, in red, the failures you have not looked at yet.
  A subagent that fails or aborts raises a toast that opens the tree on it. On Home, an agent's card lists its running
  subagents, and an agent whose subagents still run counts as working.
- **Files panel with an editor (⌃⌘4).** cockpit's Files tab shows Herdr's `files` mod, a read-only preview. Here the
  tab is an editor: the focused pane's folder as a tree with git marks, and a click opens the file with syntax
  highlighting. ⌘S saves. Herdr refuses a save when the file changed on disk since it was read, and you choose
  between reloading and overwriting. A file an agent rewrites reloads by itself while you have no unsaved edits. New
  file and new folder sit in the header and on each folder's row, rename and delete on every row. Nothing is ever
  overwritten, and every delete stops at a confirm.
- **Session restore.** When Herdr gives a terminal a fresh shell (a reboot, a logout, a herdr-core crash), the Claude
  Code, Codex or OMP session that ran in it comes back: lstack-herdr types the tool's resume command into the new
  shell, with the flags the tool was started with. While a tool runs, its session is recorded in a terminal label;
  quit the tool and the record goes after 60 seconds. This is separate from cockpit's own ⌥⌘R.
- **Sync.** The fork is generated, never edited. When cockpit updates, a toast offers Sync, which rebuilds the fork
  from the new cockpit and the hand-written source in `mods/lstack-herdr/`.

The panels lstack-herdr adds are labelled in Korean (`에이전트 호출 트리`, `실행`, `기록 열기`, `저장` and so on).
cockpit's own views keep their English labels.

## Requirements

| | |
|---|---|
| macOS | the only system this layout was built and used on |
| [Herdr app](https://herdr.dev) | built on 0.1.16; `herdr-app` on `PATH` for the install steps |
| [cockpit](https://github.com/quaresc/cockpit) | 0.38.5, installed for the Herdr app; `cockpit doctor` checks what cockpit itself needs, such as `gh` and `jq` |
| [Node.js](https://nodejs.org) | `node` on `PATH`: Sync and the call tree's transcript reader run with it |
| [OMP](https://omp.sh) (optional) | the call tree reads OMP's subagents; live updates need the extension in `mods/lstack-herdr/omp/` |

## Install

The names are fixed: `sync.mjs` hardcodes `mods/lstack-herdr`, `mods/lstack-herdr-cockpit` and
`layouts/lstack-herdr.json`. Paths below assume the Herdr app's home is `~/.config/herdr-app`.

1. Install cockpit 0.38.5:

   ```sh
   curl -fsSL https://raw.githubusercontent.com/quaresc/cockpit/main/install.sh | COCKPIT_VERSION=0.38.5 sh
   ```

   The installer runs `cockpit setup`, or tells you to. If `~/.config/herdr-app/mods/cockpit/` is still missing
   afterwards, run `cockpit app install`. Then run `cockpit doctor`.

2. Copy the layout without overwriting anything:

   ```sh
   git clone https://github.com/Lapis0875/herdr-lstack-layout.git
   cd herdr-lstack-layout
   APP=~/.config/herdr-app
   for p in mods/lstack-herdr mods/lstack-herdr-cockpit layouts/lstack-herdr.json layouts/lstack-herdr.svg; do
     [ -e "$APP/$p" ] && echo "already there: $APP/$p"
   done
   ```

   If that prints anything, stop: another copy is installed, and two cannot sit side by side. Otherwise:

   ```sh
   cp -R mods/lstack-herdr mods/lstack-herdr-cockpit "$APP/mods/"
   cp layouts/lstack-herdr.json layouts/lstack-herdr.svg "$APP/layouts/"
   ```

3. Add the keys:

   ```sh
   node ~/.config/herdr-app/mods/lstack-herdr/sync.mjs --check   # lists what it would change, writes nothing
   node ~/.config/herdr-app/mods/lstack-herdr/sync.mjs
   ```

   It writes the `layout:lstack-herdr` section of `keys.json` from your `layout:cockpit` section plus ⌃⌘6, and
   rebuilds the fork only when your cockpit differs from the one this repository was built from. Your other sections
   keep their bindings. To do it by hand instead, merge this repository's `keys.json` (one section,
   `layout:lstack-herdr`) into yours.

4. Optional, for the live call tree in OMP:

   ```sh
   mkdir -p ~/.omp/agent/extensions
   ln -s ~/.config/herdr-app/mods/lstack-herdr/omp/lstack-herdr-tree.ts ~/.omp/agent/extensions/
   ```

   Then restart omp. Without the extension, the tree still finds OMP sessions through the files OMP keeps per
   terminal, and tags their statuses `추정` (estimated).

5. Check both mods:

   ```sh
   herdr-app check ~/.config/herdr-app/mods/lstack-herdr-cockpit
   herdr-app check ~/.config/herdr-app/mods/lstack-herdr
   ```

6. Switch to the layout:

   ```sh
   herdr-app do layout.switch '{"name":"lstack-herdr"}'
   ```

   `ctrl-shift-l` cycles back through your other layouts.

## Keys

The section `layout:lstack-herdr` in `keys.json` applies only while this layout shows. It holds cockpit's 24 bindings,
renamed from `cockpit.` to `lstack-herdr-cockpit.`, plus ⌃⌘6. A side panel key pressed while its tab already shows
closes the panel.

| Key | Action | What it does |
|---|---|---|
| ⇧⌘P `cmd-shift-p` | `lstack-herdr-cockpit.palette` | the palette: Herdr's commands, layouts, cockpit's apps and commands, spaces, tabs, agents |
| ⌥⌘0 `cmd-alt-0` | `lstack-herdr-cockpit.home` | Home, or back to the work view |
| ⌥⌘1 `cmd-alt-1` | `lstack-herdr-cockpit.go:inbox` | Inbox in the center |
| ⌥⌘2 `cmd-alt-2` | `lstack-herdr-cockpit.go:runbook` | Runbook in the center |
| ⌥⌘3 `cmd-alt-3` | `lstack-herdr-cockpit.go:todo` | To-do in the center |
| ⌥⌘4 `cmd-alt-4` | `lstack-herdr-cockpit.go:meetings` | Meetings in the center |
| ⌥⌘5 `cmd-alt-5` | `lstack-herdr-cockpit.go:monitor` | Monitor in the center |
| ⌥⌘6 `cmd-alt-6` | `lstack-herdr-cockpit.go:routines` | Routines in the center |
| ⌥⌘7 `cmd-alt-7` | `lstack-herdr-cockpit.go:mail` | Mail in the center |
| ⌥⌘A `cmd-alt-a` | `lstack-herdr-cockpit.agent-view` | the work view switches between the panes and the focused agent |
| ⌥⌘B `cmd-alt-b` | `lstack-herdr-cockpit.panel` | shows or hides the side panel |
| ⌃⌘1 `ctrl-cmd-1` | `lstack-herdr-cockpit.panel:show` | side panel tab Documents |
| ⌃⌘2 `ctrl-cmd-2` | `lstack-herdr-cockpit.panel:review` | side panel tab Review |
| ⌃⌘3 `ctrl-cmd-3` | `lstack-herdr-cockpit.panel:runbook` | side panel tab Runbook |
| ⌃⌘4 `ctrl-cmd-4` | `lstack-herdr-cockpit.panel:files` | side panel tab Files, with the editor |
| ⌃⌘5 `ctrl-cmd-5` | `lstack-herdr-cockpit.panel:changes` | side panel tab Changes |
| ⌃⌘6 `ctrl-cmd-6` | `lstack-herdr-cockpit.panel:tree` | side panel tab 에이전트 호출 트리 (added by lstack-herdr) |
| ⌘J `cmd-j` | `lstack-herdr-cockpit.next-waiting` | the next agent that needs you, else the next finished one |
| ⇧⌘J `cmd-shift-j` | `lstack-herdr-cockpit.next:blocked` | the next agent that needs you |
| ⇧⌘U `cmd-shift-u` | `lstack-herdr-cockpit.next:done` | the next finished agent |
| ⌥⌘Q `cmd-alt-q` | `lstack-herdr-cockpit.queue` | the prompt queue of the agent in front |
| ⌥⌘R `cmd-alt-r` | `lstack-herdr-cockpit.resume` | cockpit's resume of agents a restart stopped |
| ⌘R `cmd-r` | `lstack-herdr-cockpit.recap` | the recap popup |
| ⌘G `cmd-g` | `lstack-herdr-cockpit.pr` | opens the focused agent's pull request |
| ⌘L `cmd-l` | `lstack-herdr-cockpit.ticket` | opens the focused agent's ticket |

## Staying current

- Every minute, lstack-herdr compares the installed cockpit version (`cockpit.json` in the Herdr app's home) with the
  one the fork was built from. When they differ, a toast says `cockpit <version> updated · Sync`; click it. You can
  also open the source view with `herdr-app do mod.open '{"name":"lstack-herdr"}'` and press Sync, or run
  `node ~/.config/herdr-app/mods/lstack-herdr/sync.mjs`.
- After a Sync that rebuilt the fork, restart Herdr. Herdr's mod runtime keeps every reloaded copy of the fork in
  memory (about 25 MB each) until it restarts. Terminals keep running through the restart.
- Warnings from a Sync (for example: cockpit added or removed a side panel, changed the Files block or bound ⌃⌘6) are
  saved in the fork's `.lstack-sync.json` exactly as the command line prints them, and the source view shows them.
- A Sync that fails has two outcomes:
  - **While checking and building**, it writes nothing. The previous fork, layout and keys stay, and the toast
    `lstack-herdr sync 실패 · 이전 포크 유지` says why. The usual reason is a cockpit release that changed a line one of
    the 17 hooks attaches to.
  - **While writing** (a full disk, a folder it cannot write), the outputs written before the failure stay replaced.
    The command line says `sync failed while writing, run it again; already replaced: …` (or `nothing was
    replaced`), and the toast `lstack-herdr sync 실패 · 일부만 바뀜, Sync를 다시 실행하세요` lists what changed. Fix
    the cause and run Sync again. The fork itself is never left half-written: it is swapped in with one rename, and
    the old one is put back if that fails.

## What it runs, reads and writes

The fork contains all of cockpit's mod and does everything cockpit's mod does; cockpit documents that. lstack-herdr's
own parts:

- **Programs.** This list is derived from the source: every `exec` and `hc` call in `mods/lstack-herdr/main.js` and
  `mods/lstack-herdr/components/`, the programs inside the `sh -c` scripts they run (shell built-ins such as `[`,
  `echo`, `printf` and `true` left out), and `lh-scan.mjs`'s own child processes. `sync.mjs` and the OMP extension
  run none.
  - `node`: `sync.mjs` (Sync, from the source view and the Sync toast), and `lh-scan.mjs` (`tree`, `detail`, `run`,
    `call`, `transcript`), the call tree's reader of OMP transcripts.
  - `ps`: run by `lh-scan.mjs` to find a terminal's tty and whether OMP still runs on it.
  - `sh -c`, the Files panel's scripts:
    - Folder listing and new file: no programs beyond the shell.
    - New folder: `mkdir`.
    - Rename: `mkdir`, `rmdir`, `mv` (`mv -T` where `mv --version` works, else `perl`), `link`, `readlink`, `ln -s`
      and `rm`.
    - Delete: `/usr/bin/trash -s` on this Mac, else `rm`.
    - Counting what a deleted folder holds: `find`, `head` and `wc`.
  - `sh -c`, the session lookup for restore. For Codex, and for OMP without the extension's session record: `pgrep`,
    then `readlink` on `/proc/<pid>/fd` where that exists (Linux), else `lsof` and `sed`, then `grep` and `head`. For
    Claude Code: `sed` and `head`.
  - `git rev-parse --show-toplevel` and `git status`: the Files panel's git marks.
  - `test -w <file>` and `test -x /usr/bin/trash`: whether a file is writable, and whether deletes can go to the
    Trash.
  - `powershell`: the folder listing on Windows.
  - `hc label` and `hc send`: session restore labels a terminal and types the resume command into it.
  - In a space on another machine, the Files panel's scripts, `git` and the session lookup run on that machine.
- **Reads** outside its own folder:
  - `~/.omp/agent/terminal-sessions/` and the OMP session transcripts they name.
  - `~/.claude/sessions/<pid>.json`, and whether the matching transcript exists under `~/.claude/projects/`.
  - The name of the rollout file a running Codex holds open (through `lsof`), not its contents.
  - `cockpit.json` in the Herdr app's home, for the installed cockpit version.
  - The focused pane's folder and the files you open in the Files panel.
- **Writes**:
  - `~/.cache/lstack-herdr/`: the transcript reader's caches, and Sync's staging folder.
  - On Sync: `mods/lstack-herdr-cockpit/`, `layouts/lstack-herdr.json`, `layouts/lstack-herdr.svg` and `keys.json`.
  - The terminal label `lstack-herdr.resume`.
  - What you save, create, rename or delete in the Files panel.
  - The OMP extension writes OSC 7501 records to the terminal OMP runs in.
- **Network**: lstack-herdr's own code opens no connection.

## On your phone and tablet: herdr-relay

[![herdr-relay intro](https://raw.githubusercontent.com/Lapis0875/herdr-relay/main/docs/media/intro.gif)](https://github.com/Lapis0875/herdr-relay)

[herdr-relay](https://github.com/Lapis0875/herdr-relay) puts your Herdr window on your phone and tablet. It runs on the
Mac next to Herdr, renders the same layouts and mods there, and serves them over your Tailscale network to a web app
you add to the home screen. You see your spaces, tabs, agents and terminals, rearranged for a small screen, and you can
act on them: switch views, run a mod's commands, type into a terminal, and get a push notification when an agent
finishes or needs you. The mods never leave the Mac: each mod folder runs in its own sandboxed process, and devices
receive only what the mods draw.

- **Status**: 0.1.0, its first public version. Apache License 2.0.
- **Where it runs**: macOS only (its mod sandbox is macOS Seatbelt) and Tailscale only. Devices: iPhone or iPad with
  Safari, or Android with Chrome, on the same tailnet.
- **Needs**: [Deno](https://deno.com) 2.9 or newer.
- **Herdr versions**: tested with 0.1.14 and 0.1.15; 0.1.13 is supported but not tested, and versions newer than
  0.1.15 run with a warning banner. This layout was built on Herdr 0.1.16, so expect that banner.

To mirror this layout, install herdr-relay as its README describes, then:

1. Install its mirror mod, which gives devices this window's exact theme, fonts and focus:

   ```sh
   herdr-relay install-mod
   ```

2. Add the entry it prints to the root `floating` list of `~/.config/herdr-app/layouts/lstack-herdr.json`, after
   `queue`:

   ```json
   { "id": "herdr-relay-mirror", "content": { "mod": "herdr-relay-mirror" }, "edge": "bottom", "align": "end" }
   ```

   A later Sync keeps it: Sync carries over floating blocks that cockpit's layout does not have.

3. Check the mirror and let it start the bridge whenever Herdr runs:

   ```sh
   herdr-app check ~/.config/herdr-app/mods/herdr-relay-mirror
   herdr-relay autostart on
   ```

**The fork needs a policy profile on devices.** herdr-relay's built-in profiles cover Herdr's shipped mods and
cockpit's folder `cockpit`, and none names `lstack-herdr-cockpit`. A folder no profile names may read its own files
and the space folders, and nothing else: its `exec`, `hc` and network calls are refused, and it still renders. This
repository ships no profile. To write one, see herdr-relay's
[docs/PROFILES.md](https://github.com/Lapis0875/herdr-relay/blob/main/docs/PROFILES.md); its section 10 works through
a mod shaped like this one (a transcript scanner with `tree`, `detail`, `run`, `call` and `transcript` subcommands, and
a `sync.mjs` devices must not start). A personal profile goes in `~/.herdr/herdr-relay/profiles/` with mode 0600, and
the bridge reads profiles when it starts.

## Limits

- **The call tree reads OMP only.** Claude Code and Codex subagents do not appear; any terminal appears as a root once
  it starts `hc` child terminals. Without the OMP extension, statuses come from transcripts alone and read `추정`.
- **255 records a terminal.** herdr-core keeps 255 live records per terminal and drops the least recently updated one
  past that; the extension sends its session record again every 64 subagent reports.
- **Files panel:** 500 entries a folder and 5,000 in all. A file over 400,000 characters opens cut short and
  read-only, as does a file in a space on another machine or one you cannot write.
- **Delete:** on this Mac with `/usr/bin/trash` (macOS 15), a delete goes to the Trash. Anywhere else it is permanent,
  and the confirm says so.
- **Session restore** reads each tool's flags as these versions' `--help` lists them: Claude Code 2.1.311, Codex
  0.167.0, OMP 18.20.3. A flag added later may be carried over wrongly. Only terminals Herdr keeps as panes take
  part, not ones an agent started. Claude Code and Codex sessions are recorded only after their first message.
- **Sync** attaches 17 hooks to exact lines of cockpit's code. A cockpit release that changes one of them fails Sync,
  safely, until the hooks are updated.
- **One copy per Herdr app home**, because the names are fixed.
- **Restart Herdr after a Sync** that rebuilt the fork.

## Uninstall

1. Switch to another layout with `ctrl-shift-l`.
2. Remove the files:

   ```sh
   APP=~/.config/herdr-app
   rm -r "$APP/mods/lstack-herdr" "$APP/mods/lstack-herdr-cockpit" "$APP/layouts/lstack-herdr.json" "$APP/layouts/lstack-herdr.svg"
   rm -rf ~/.cache/lstack-herdr
   rm -f ~/.omp/agent/extensions/lstack-herdr-tree.ts
   ```

3. Remove the `layout:lstack-herdr` section from `~/.config/herdr-app/keys.json`, by hand or with
   `jq 'del(.["layout:lstack-herdr"])'`.

Terminals keep their `lstack-herdr.resume` label until they close; nothing reads it once the layout is gone.

## Credits

- [cockpit](https://github.com/quaresc/cockpit) by quaresc: the layout, mod and keys this is built on.
- The [Herdr app](https://herdr.dev): its `files` mod, where the Files panel's tree comes from.
- [herdr-editor-layout](https://github.com/yama-lei/herdr-editor-layout) and
  [herdr-blueprint-app](https://github.com/chappse6/herdr-blueprint-app), through cockpit's code view and diagrams.
- [Lucide](https://github.com/lucide-icons/lucide) and Feather: the icons.

## License

MIT © 2026 Lapis0875, see [LICENSE](LICENSE). The parts from other projects keep their own licences:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), with the Apache License 2.0 text in
[LICENSES/Apache-2.0.txt](LICENSES/Apache-2.0.txt).
