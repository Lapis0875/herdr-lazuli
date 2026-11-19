# lazuli

lazuli is a Herdr app layout for working with coding agents, drawn by one hand-written mod, `mods/lazuli`. This file
is its developer guide: how it is put together and how to work on it. What it does for the person is in
[README.md](README.md); the requirements it was built to are [docs/DESIGN.md](docs/DESIGN.md) (section IDs such as
B3), the module design is [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), the module contracts are
[docs/CONTRACTS.md](docs/CONTRACTS.md), and the live acceptance scenarios are [docs/TESTING.md](docs/TESTING.md).

![lazuli](layouts/lazuli.svg)

## Built from

### The layout

`layouts/lazuli.json`, root attributes: `"titlebar": "none"`, `"traffic_lights": [12, 16]`, `"background": "canvas"`,
`"terminal_padding": [14, 12]`, a 1 px `border` divider, `"preview": "layouts/lazuli.svg"`,
`"theme": {"light": "lazuli-light", "dark": "lazuli-dark"}` and `"ui_font": "Pretendard"`. `lazuli {view: …}` below is
the mod `lazuli` with those props; a card is radius 10 on `background`.

```text
root  row
│     floating: queue  lazuli {view: queue} · edge right · align center · peek 44
├─ sidebar  column · 268 px (44–480) · chrome · resizable false
│  ├─ brand           46 px · window_drag             lazuli {view: brand}
│  ├─ nav             weight 1 · min 120               lazuli {view: sidebar}
│  └─ sidebar-footer  69 px                            lazuli {view: sidebar, footer: true}
└─ main-area  column · resizable false
   ├─ topbar  row · 42 px
   │  ├─ tabs  window_drag                              tabs (Herdr's)
   │  └─ bell  52 px · window_drag                      lazuli {view: bell}
   ├─ body  row · padding [0, 8] · gap 8
   │  ├─ center  stack · active home
   │  │  ├─ home  row · gap 8
   │  │  │  ├─ home-board  card                          lazuli {view: home}
   │  │  │  └─ home-agent  column · hidden · 600 px (360–1100)
   │  │  │     └─ home-agent-card  card: home-agent-head 34 px lazuli {view: agent-head, place: home}
   │  │  │                               home-agent-term       {agent: focused}
   │  │  ├─ work  row · gap 8
   │  │  │  ├─ view  stack · active main
   │  │  │  │  ├─ main   {tab: active, pane: {…, header: lazuli {view: pane-head}}}
   │  │  │  │  └─ agent  card: agent-head 34 px lazuli {view: agent-head, place: work}; agent-term {agent: focused}
   │  │  │  └─ panel  row · hidden · 420 px (280–900) · card
   │  │  │     └─ panel-body  stack · active files
   │  │  │        ├─ review    lazuli {view: review}
   │  │  │        ├─ files     lazuli {view: files}
   │  │  │        ├─ changes   changes (Herdr's)
   │  │  │        └─ tree      lazuli {view: tree}
   │  │  ├─ inbox     card                               lazuli {view: inbox}
   │  │  ├─ todo      card                               lazuli {view: todo}
   │  │  └─ routines  card                               lazuli {view: routines}
   │  └─ activity  44 px · card                          lazuli {view: activity, stack: panel-body}
   └─ status  34 px                                      lazuli {view: status}
```

Other views open as overlays (`openOverlay`) or tabs: `palette`, `quickopen`, `settings`, `menu`, `recap`, `queue`
(as a dialog), `run`, `transcript`, `file` (a file tab, `tab.new`) and `gallery` (every `ui/kit.js` component, for
screenshots).

### The mod

| Path | What it holds |
|---|---|
| `main.js` | the `VIEWS` registry: `props().view` picks the view class; every copy pumps `nextCommand()` into `sys/bus.js` |
| `core/` | pure logic: no `herdr`, `gpui-kit`, `fs/promises` or `net` imports; time, randomness and file contents come in as arguments. Node tests import it directly |
| `core/catalog/` | the UI text, one `<area>.en.js` and `<area>.ko.js` pair per area |
| `sys/` | services and shared state: the store and settings (`store.js`, `state.js`), the command table (`bus.js`), GitHub (`gh.js`), agents (`fleet.js`), call tree and spend (`scan.js`), routines (`routines.js`, `runner.js`), queue, to-do, session restore, notifications, migration, file tabs, the PDF sidecar, palette search, review |
| `ui/` | `tokens.js` (the only module that reads `theme()` and `settings()`), `kit.js` (Button, Icon, Row, Badge, Field, Tabs, Menu, …), `icons/*.svg`, the logo |
| `views/` | one module per view, with parts in `views/apps/`, `views/panels/` and `views/shell/` |
| `file/` | the file tab: `model.js` (load, save, conflicts, drafts; no elements) and one view per kind |
| `bin/` | Node programs: `scan.mjs` (transcript reader), `run-agent.mjs` (headless run wrapper), `html-view.mjs` and `chrome-broker.mjs` (HTML viewer and its shared Chrome), `lib/`; and `pdfd.swift` (the PDF renderer, compiled at layout start) |
| `vendor/` | `marked.esm.js` and its licence |
| `fonts/` | Pretendard, which Herdr loads from the mod's `fonts/` folder |
| `omp/` | `lazuli-tree.ts`, the OMP extension behind the live call tree |

How the pieces meet:

- **One copy per block.** Herdr runs a copy of the mod for every block and overlay, but module scope runs once and is
  shared by every copy. Services keep their state at module level; a view keeps only its own UI state.
- **The `status` copy owns the window.** It is always shown and exists once, so it starts every service in `init`
  (`views/shell/services.js`: migration first, then data services, notifications, file tabs, the PDF sidecar) and
  handles the window-wide commands. `sys/bus.js` lets only a command's owner act: `status` for the keys, the focused
  tab's `file` copy for `file-mode`, the receiving copy for `key:` and `focus`.
- **Stores and snapshots.** A service changes a store in `sys/store.js`, writes `data/lazuli/snap/<name>.json` and
  bumps `shared("lazuli.rev")`, which redraws every copy. The snapshots give a warm start and feed herdr-relay
  devices.
- **Settings** live in `data/lazuli/settings.json`, mirrored to `shared("lazuli.settings")` so a change applies at once.
- **Long-lived processes** start detached with `hc run --bg` (headless runs, the PDF renderer) or in a terminal pane
  (`pane.split`, the HTML viewer), because `exec` waits for exit and stops at 600 s.

## Working on it

### Run it from the repository

During development `~/.config/herdr-app/mods/lazuli` is a symlink to this repository's `mods/lazuli`, so Herdr runs
the working copy. Copy the layout, its SVG and the themes in, and merge the `layout:lazuli` keys, as the README's
install steps describe. Herdr loads a mod's module code again when its source changes. Remove the symlink before
installing a real copy.

### Tests

```sh
npm test                      # node --test tests/
node --test tests/i18n.test.mjs   # one file
```

The tests cover the pure logic in `core/`, the Node programs in `bin/`, and the structure: `purity.test.mjs` (no
platform imports in `core/`), `layout.test.mjs` (unique ids, every `view` in `VIEWS`, every `keys.json` action in the
command table, the Files tab as the panel default, the rail outside the panel), `theme.test.mjs` (contrast of each
text/background pair, 16 ANSI colors), `i18n.test.mjs` (both languages have the same keys and placeholders, no empty
text), `relay-profile.test.mjs` (the relay profile, and every script it names exists).

### `herdr-app check`

```sh
herdr-app check ~/.config/herdr-app/mods/lazuli
```

It loads the mod once with empty shared state and checks its first render. It does not lay views out or run later
async states, and `net` and `websocket` throw under it, so every service is guarded with `checking()`. A passing
check is necessary, not sufficient: try the change in the window too (docs/TESTING.md).

### Preview a view in a tab

Every view takes `preview: true` in its props and then draws without acting: it starts no service, and its buttons,
keys and timers change nothing. The Files view still lists its folder once, and Review draws what the real panel last
read. Open one as a tab of its own to look at it beside the real one:

```sh
herdr-app do tab.new '{"mod":"lazuli","name":"home preview","props":{"view":"home","preview":true}}'
herdr-app do tab.new '{"mod":"lazuli","name":"kit","props":{"view":"gallery"}}'
```

The one exception is `view: "file"`: there `preview: true` means the space's preview tab (DESIGN B2), and the tab
loads, watches and saves its file as any file tab does.

To drive a view from the command line, send its commands or keystrokes: `herdr-app do lazuli.go:inbox`,
`herdr-app do lazuli.key:j` (the `key:` test hook reaches the `key()` handler of every shown copy), then
`herdr-app shot <file>.png`.

### Add UI text

1. Pick the area (`common shell home inbox todo routines review files tree filetab palette settings gallery
   viewer`) and add the key to both `core/catalog/<area>.en.js` and `<area>.ko.js`. Keys start with the area:
   `"inbox.action.merge"`.
2. Use the same `{name}` placeholders in both languages. Keep product terms in English in both (PR, CI, Diff).
3. Use it with `t("inbox.action.merge", {…})` from `core/i18n.js`. A missing Korean text falls back to English, then
   to the key.
4. A new area also needs its pair imported in `core/catalog/index.js` and added to `AREAS` and `fragments`.
5. Run `node --test tests/i18n.test.mjs`.

AI prompts are written in English and end with a line asking for the answer in the person's language.

### Add an icon

1. Take the Lucide icon's SVG (https://lucide.dev), set `stroke-width="1.75"` like the others, and save it as
   `mods/lazuli/ui/icons/<name>.svg`.
2. Draw it with `Icon("<name>", {size, color})` from `ui/kit.js`, and add the name to the `ICONS` list in
   `views/gallery.js`.
3. An icon from anywhere else needs its licence checked and a line in `THIRD_PARTY_NOTICES.md`.

### Add a key command

1. Bind it in `keys.json`, section `layout:lazuli`, as `lazuli.<command>`.
2. Add `<command>` to `COMMANDS` in `sys/state.js` with its owner (`status` for window-wide commands).
3. Handle it: a route in `sys/bus.js`, a handler a service registers with `handle(name, fn)`, or the owner view's
   `command(command, cx)`.
4. `layout.test.mjs` fails until every bound action is in the table. Check the key against the `global` section of the
   installed `keys.json` first.

### Add a program call

Run programs with `exec(program, args, {on, timeout})`, every path an argument and never part of a shell string.
Then update the README's "What it runs, reads and writes". If herdr-relay devices should run a new script of
`bin/`, declare it in `relay/lazuli.profile.json`: a run form for a script that only reads and writes under
`~/.cache/lazuli`, else a `refuse` form.

## Watch out

- **Module scope is shared.** Two copies of the same view share every module-level variable. Keep per-copy state on
  the view object.
- **Window-wide commands reach every shown copy.** Only the owner may act (`sys/bus.js`); a second handler elsewhere
  runs the action twice.
- **`close()` gets 250 ms.** Nothing may prompt there; unsaved edits survive as drafts instead.
- **`image()` caches by path.** A file overwritten in place under `data/` keeps showing the old picture (spike S3), so
  every rendered page and cached picture gets a new file name.
- **`exec` waits for exit** and stops at 600 s. Start anything longer with `hc run --bg`; a finished terminal stays
  until `hc rm`.
- **A notification click** can run `herdr-app do lazuli.<command>` only while a copy of the mod is shown (spike S2); the
  `status` copy always is. lazuli uses the click only for `agent.focus`.
- **No italic.** Pretendard has no italic face; emphasis is weight or color, never `italic()`.
- **Names are fixed.** The mod folder must be `lazuli`: `bin/` paths, `keys.json` actions, shared keys (`lazuli.*`) and
  terminal labels use the name.
- **The relay profile.** herdr-relay runs `bin/scan.mjs` under Deno, so it may use only `node:` built-ins, `ps` and its
  cache folder; a call with an argument starting with `-` or more than three arguments is refused.
- **Files over 600 lines** are split when they are next touched; `bin/pdfd.swift` stays one file because it is compiled
  as one.

## Done when

1. `npm test` passes.
2. `herdr-app check ~/.config/herdr-app/mods/lazuli` passes.
3. The scenarios of [docs/TESTING.md](docs/TESTING.md) pass in the live window, each with its screenshot.
