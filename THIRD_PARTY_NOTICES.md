# Third-party notices

lazuli is released under the MIT licence (see `LICENSE`). Some of its files are ported from, or ship parts of, other
open-source projects, which keep their own licences. This file names them and carries their notices. Every path below
is relative to this repository.

| Project | Licence | What lazuli has from it | Licence text |
|---|---|---|---|
| [cockpit](#cockpit) 0.38.5 | MIT | code ported to JavaScript: review diff, walkthrough, GitHub query, to-do, queue and routine formats | below |
| [herdr-walkthrough](#herdr-walkthrough) | MIT | the walkthrough prompt, schema and checks, through cockpit | below |
| [marked](#marked) 18.2.1 | MIT | `mods/lazuli/vendor/marked.esm.js` | `mods/lazuli/vendor/marked.LICENSE` |
| [Herdr app](#herdr-app) | Apache-2.0 | the Files panel's folder listing and tree, ported; the sidebar glyph | `LICENSES/Apache-2.0.txt` |
| [Lucide](#isc-license-lucide) | ISC (Feather icons: MIT) | the icons in `mods/lazuli/ui/icons/` | `LICENSES/Lucide.txt` |
| [Pretendard](#sil-open-font-license-11-pretendard) | SIL OFL 1.1 | `mods/lazuli/fonts/Pretendard-*.otf` | `mods/lazuli/fonts/Pretendard-OFL.txt` |

Loaded at run time, not shipped: [mermaid and KaTeX](#mermaid-and-katex).

## MIT License

### cockpit

- Source: https://github.com/quaresc/cockpit, release 0.38.5.
- No cockpit file ships here. These lazuli files port cockpit's code (Rust, or JavaScript of its Herdr mod) to
  lazuli's JavaScript, and each says so in its header comment:

  | lazuli file | Ported from cockpit 0.38.5 |
  |---|---|
  | `mods/lazuli/sys/review.js` | `herdr/tui/show/src/review.rs` and `patch.rs`: the diff parser and changed-word marking |
  | `mods/lazuli/views/diff.js` | the behavior of its mod's `diff.js`: the diff view |
  | `mods/lazuli/sys/review-walk.js` | `herdr/tui/show/src/walkthrough.rs`: the walkthrough's prompt, JSON schema and the checks on the answer (after herdr-walkthrough, below) |
  | `mods/lazuli/views/panels/review-walk-view.js` | the walkthrough view over that data |
  | `mods/lazuli/core/gh-map.js` | `hub/src/feed/github.rs`, `github_ci.rs` and `hub/src/events.rs`: the GitHub GraphQL query and what is read from it |
  | `mods/lazuli/sys/gh.js` | the review-thread query and detail cache of `hub/src/fetch.rs` (`docs/ARCHITECTURE.md` §4.1) |
  | `mods/lazuli/core/todo-doc.js`, `mods/lazuli/sys/todo.js` | `herdr/tui/todo/src/doc.rs` and `todo/src/gui.rs`: the to-do file format and its edits |
  | `mods/lazuli/core/queue-doc.js`, `mods/lazuli/sys/queue.js` | `herdr/tui/cli/src/queue.rs`: the prompt queue (`prompt`, `edit`, `act`) |
  | `mods/lazuli/core/routine-file.js` | `core/src/routines.rs`: the routine file format and `when` |
  | `mods/lazuli/core/routine-sched.js` | `hub/src/routines.rs`: the scheduler (`round`, `schedule`, `listen`, `start_queued`, `finish`) |
  | `mods/lazuli/sys/routines.js`, `mods/lazuli/sys/runner.js` | `hub/src/routines.rs`: `problems`, the run argv, and the worktree handling (`worktree`, `settle`, `remove_worktree`) |
  | `mods/lazuli/core/ledger.js` | `agents/src/ledger.rs`: the working-time ledger format |
  | `mods/lazuli/core/agent-cmd.js` | `core/src/agent.rs`: the headless argv forms |

```text
MIT License

Copyright (c) 2026 quaresc

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### herdr-walkthrough

- Source: https://github.com/dmazlum/herdr-walkthrough
- In cockpit: `herdr/tui/show/src/walkthrough.rs`, the review walkthrough's prompt, JSON schema and the checks on the
  answer (as cockpit's own notices say).
- In this repository: `mods/lazuli/sys/review-walk.js` and `mods/lazuli/views/panels/review-walk-view.js`, ported
  from cockpit's walkthrough (above).

```text
MIT License

Copyright (c) 2026 Devrim Mazlum

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

### marked

- Source: https://github.com/markedjs/marked, version 18.2.1, its one-file ES module build `lib/marked.esm.js`.
- In this repository: `mods/lazuli/vendor/marked.esm.js`, the one vendored file (its header: `marked v18.2.1`). The
  Markdown preview of file tabs parses with it, and so does the HTML viewer's rendered Markdown page
  (`mods/lazuli/bin/lib/md-page.mjs`).
- Its licence file ships beside it as `mods/lazuli/vendor/marked.LICENSE`: the MIT License (© 2018+ MarkedJS,
  © 2011-2018 Christopher Jeffrey) and the licence of the original Markdown (© 2004 John Gruber).

## Apache License 2.0

The full licence text is in `LICENSES/Apache-2.0.txt`.

### Herdr app

- Source: the Herdr app (https://herdr.dev), 0.1.16, and the mods it ships. The app's `LICENSE` is the Apache License
  2.0 text and names no copyright holder, so the credit goes to the Herdr app (herdr.dev).
- From its `files` mod: the folder tree of the Files panel, ported (through lstack-herdr's Files panel, which ported
  it first) and changed by lazuli:
  - `mods/lazuli/views/files-ops.js`: the folder listing (Herdr's `sh -c` listing script byte for byte, run with
    `lazuli-files` as its `$0`, and the PowerShell listing for Windows) and the git marks from
    `git status --porcelain=v1`. Changed: new file, new folder, rename and delete added, and the branch read with the
    marks.
  - `mods/lazuli/views/files-tree.js`: the tree that loads a folder when it opens, with 500 entries a folder and 5,000
    in all. Changed: redrawn in lazuli's design, files open in center tabs, and the file operations above.
  - Both files say in their header comment that they come from Herdr's `files` mod under the Apache License 2.0, as
    section 4(b) of the licence asks of changed files.
- From its `workspace-chrome` mod: `mods/lazuli/ui/icons/sidebar.svg`, its `sidebar.svg` glyph with a stroke width of
  1.75 instead of 1.5.

## ISC License: Lucide

- Source: https://github.com/lucide-icons/lucide. 37 of the icons were taken from the `lucide-static` package, version
  1.75.0; `coffee.svg` (the herdr-caffeinate chip) was taken from the Lucide repository (`main`, commit `891daab`); 8
  more for the Assistant screen (`at-sign.svg`, `brain.svg`, `folder-open.svg`, `folder-x.svg`, `laptop.svg`,
  `navigation.svg`, `paperclip.svg`, `square-slash.svg`) were taken from Lucide for its prototype
  (`docs/mockups/assistant/icons-new/`) and copied with the same paths, in the file layout of the rest of the set.
- In this repository: every icon in `mods/lazuli/ui/icons/` except `sidebar.svg` (Herdr's, above), drawn with a stroke
  width of 1.75; a few under other file names (for example, `external.svg` is Lucide's `external-link`).
- The licence, with the MIT License of the icons Lucide derives from Feather (© 2013-present Cole Bemis), is in
  `LICENSES/Lucide.txt`.

## SIL Open Font License 1.1: Pretendard

- Source: https://github.com/orioncactus/pretendard, © 2021 Kil Hyung-jin, with Reserved Font Name Pretendard.
- In this repository: `mods/lazuli/fonts/Pretendard-Regular.otf`, `Pretendard-Medium.otf`, `Pretendard-SemiBold.otf`
  and `Pretendard-Bold.otf`. Herdr loads them from the mod's `fonts/` folder; the layout names
  `"ui_font": "Pretendard"`.
- The licence ships beside the fonts, as the licence requires: `mods/lazuli/fonts/Pretendard-OFL.txt`.

## Loaded at run time, not shipped

### mermaid and KaTeX

The HTML viewer's rendered Markdown page ("View in Chrome", `mods/lazuli/bin/lib/md-page.mjs`) loads these from
`cdn.jsdelivr.net` into the headless browser, pinned by version and by subresource integrity (sha384), and only when the
page has a diagram or math. No file of either project is in this repository.

- mermaid 12.3.0 (MIT): https://github.com/mermaid-js/mermaid
- KaTeX 0.19.1 (MIT): https://github.com/KaTeX/KaTeX
