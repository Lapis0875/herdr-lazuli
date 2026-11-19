// The brand row at the top of the sidebar (mockup A): the lazuli logo and name, then search (the palette, ⇧⌘P) and
// the sidebar fold. The block is a window-drag area under the macOS traffic lights, so the row leaves them 76 px; the
// buttons keep their presses (ui/kit.js stops the drag). Folded to the rail, only the fold button stays (none on
// macOS, where the traffic lights fill the row and the sidebar's own unfold button shows).

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { props, window as appWindow } from "herdr";
import { t } from "../core/i18n.js";
import { tokens } from "../ui/tokens.js";
import { ViewRoot, Logo, IconButton } from "../ui/kit.js";
import { sidebarNarrow, togglePalette, toggleSidebar } from "./shell/actions.js";

export default class Brand {
  constructor(name) {
    this.name = name;
  }

  init(p, _cx) {
    this.props = props() ?? p ?? {};
    this.preview = this.props.preview === true;
  }

  render(_cx) {
    const k = tokens();
    const narrow = sidebarNarrow();
    const w = appWindow();
    const lights = w?.platform === "macos" && !w?.fullscreen;
    const fold = IconButton("brand-fold", "sidebar", narrow ? t("shell.brand.unfold") : t("shell.brand.fold"), { onClick: () => !this.preview && toggleSidebar() });
    const root = ViewRoot("lz-brand", { bg: k.bg.chrome }).flex_row().items_center();
    if (narrow) return root.justify_center().when(!lights, (e) => e.child(fold));
    return root
      .pl(lights ? 76 : 14)
      .pr(10)
      .gap(4)
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .gap(8)
          .items_center()
          .child(Logo({ size: 20 }))
          .child(div().truncate().font_weight(k.weight.semibold).text_color(k.text.primary).child(t("shell.brand.name"))),
      )
      .child(IconButton("brand-search", "search", t("shell.brand.search"), { tooltip: `${t("shell.brand.search")}  ⇧⌘P`, onClick: () => !this.preview && togglePalette() }))
      .child(fold);
  }
}
