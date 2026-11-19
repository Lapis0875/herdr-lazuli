# Spike results (final, 2026-11-19)

S1–S7 were run by slice T00 in the owner's live Herdr 0.1.16 window (space `lazuli-spike`). The manual and restart
parts were completed by the owner and Main afterwards; their evidence is below. Per-spike details: `S1.md` … `S7.md`.

| Spike | Verdict | Evidence summary |
|---|---|---|
| S1 Kitty graphics + input in a terminal pane split into a mod tab | **Pass** | PNG drawn at exact size; title in `panes()`; zoom and SIGHUP on close (S1.md). Manual: 787 SGR mouse reports in pixel units (move 368, drag 242, press/release 3/3, wheel up 55 / down 42 / left 16 / right 58). Keyboard: Hangul arrived as composed syllables `한 글 테 스 트` (U+D55C U+AE00 U+D14C U+C2A4 U+D2B8), Enter as `\r`, Esc as kitty `CSI 27 u`, Backspace as `0x7f`. |
| S2 terminal-notifier on macOS 27 | **Pass** | After the owner re-allowed notifications, `-diagnose` reports `authorized`, banners. Both posts exited 0 at once (a post does not wait for the click). Clicks ran both `-execute` commands (`N1 clicked 18:05:24Z`, `N2 clicked 18:05:25Z`). N2's `herdr-app do lz-spike.ping` failed with "need the mod loaded": a `<mod>.<cmd>` from a notification works only while a copy of that mod is shown (lazuli's always-shown `status` copy satisfies this); built-ins such as `agent.focus` are unaffected. |
| S3 `image()` reload | **Pass** | New file name shows the new picture; overwrite in place under `data/` stays stale (S3.md). |
| S4 `net` / `websocket` live | **Pass** | TCP round trip 0–5 ms; WebSocket ~54 ms; both throw under `herdr-app check` → guard with `checking()` (S4.md). |
| S5 `hc run --bg` detachment | **Pass** | Before restart: no parent, invisible, outlives 600 s, `hc kill` = SIGHUP to the group (S5.md). Restart: run `t45` (pid 20800) was `live` with the same pid after ⌘Q + reopen, 0 matches in `herdr-app ls`; then `hc kill` (signal 1) + `hc rm`. |
| S6 tab identity | **Pass** | Before restart: each copy resolves its own tab at first render (S6.md). Restart: `shared` registry identical before/after (`diff` empty); tab ids unchanged; showing tabs A, B, C resolved each to its own id (`A → tba62f…`, `B → tba633…`, `C → tbd1bb…`) while `focused().tab` read in `init` was the previously shown tab in every case. |
| S7 `marked` under QuickJS | **Pass** | Import and lexing identical to Node (S7.md). Manual: 4 link clicks logged (2 TextView, 2 span), the span path lazuli uses works. Bold/italic need real font faces: Pretendard (bundled) provides weights, no italic. |

Cleanup done: spike tabs closed (space `lazuli-spike` kept with one shell tab for lazuli previews), shared key
`lzspike.s6reg` cleared, `mods/lz-spike`, `data/lz-spike` and `/tmp/lz-spike*` removed, run `t45` killed and removed.
`terminal-notifier` 3.1.0 stays installed (DESIGN A8).
