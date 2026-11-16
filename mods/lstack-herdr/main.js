// lstack-herdr: the hand-written source of what this layout adds to cockpit, the agent call tree, the Files panel's
// editor and session restore (components/lh-resume.js: Claude Code, Codex and OMP
// sessions come back in their terminals after a reboot). Herdr loads every folder under mods/ as a mod, so this one
// has a small view of its own (mod.json: place none, so it docks nowhere); `mod.open lstack-herdr` shows it.
// The layout runs the generated fork instead: mods/lstack-herdr-cockpit/ and layouts/lstack-herdr.json, which
// sync.mjs builds from upstream cockpit plus components/ and hooks.mjs. Edit here, then sync; never edit the fork.

import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { exec, appHome, theme, readTextFile, run } from "herdr";

export default class LstackHerdrSource extends View {
  init(_props, cx) {
    this.status = null;
    this.busy = false;
    this.check(cx);
  }

  check(cx) {
    cx.spawn(async (cx) => {
      const [install, stamp] = await Promise.all([
        readTextFile(`${appHome()}/cockpit.json`).then((t) => JSON.parse(t ?? "null")).catch(() => null),
        readTextFile(`${appHome()}/mods/lstack-herdr-cockpit/.lstack-sync.json`).then((t) => JSON.parse(t ?? "null")).catch(() => null),
      ]);
      this.status = { upstream: install?.version ?? "?", built: stamp?.cockpit ?? "never", warnings: stamp?.warnings ?? [] };
      cx.notify();
    });
  }

  sync(cx) {
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await exec("node", [`${appHome()}/mods/lstack-herdr/sync.mjs`]).catch((e) => ({ code: 1, stdout: "", stderr: String(e?.message ?? e) }));
      this.busy = false;
      this.result = (r.stdout || r.stderr).trim();
      this.check(cx);
    });
  }

  render(cx) {
    const t = theme();
    const line = (text, color = t.muted) => div().text_size(12).text_color(color).child(text);
    return v_flex()
      .id("lstack-herdr-source")
      .size_full()
      .p(16)
      .gap(8)
      .bg(t.background)
      .text_color(t.foreground)
      .child(div().text_size(13).font_semibold().child("lstack-herdr · 에이전트 호출 트리 (source)"))
      .child(line("레이아웃에 에이전트 호출 트리(⌃⌘6)와 Files 패널의 편집기를 더합니다."))
      .child(line("재부팅 등으로 터미널이 새 셸로 바뀌면 그 안에서 돌던 Claude Code·Codex·OMP 세션을 resume 명령으로 다시 엽니다."))
      .child(line("이 폴더가 원본입니다. 레이아웃은 sync.mjs가 만든 mods/lstack-herdr-cockpit/ 과 layouts/lstack-herdr.json 을 씁니다."))
      .child(line(this.status ? `cockpit ${this.status.upstream} · 포크는 ${this.status.built}에서 생성` : "확인 중…"))
      .children((this.status?.warnings ?? []).map((w) => line(`주의: ${w}`, t.working)))
      .when(Boolean(this.result), (e) => e.child(line(this.result, t.foreground)))
      .child(
        h_flex()
          .gap(8)
          .child(
            h_flex()
              .id("lstack-herdr-sync")
              .h(28)
              .px(10)
              .items_center()
              .rounded(6)
              .border_1()
              .border_color(t.border)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .text_size(12)
              .child(this.busy ? "sync 중…" : "Sync")
              .on_click((_e, cx) => this.busy || this.sync(cx)),
          )
          .child(
            h_flex()
              .id("lstack-herdr-switch")
              .h(28)
              .px(10)
              .items_center()
              .rounded(6)
              .border_1()
              .border_color(t.border)
              .cursor_pointer()
              .hover((s) => s.bg(t.hover))
              .text_size(12)
              .child("lstack-herdr 레이아웃으로")
              .on_click(() => run("layout.switch", { name: "lstack-herdr" })),
          ),
      );
  }
}
