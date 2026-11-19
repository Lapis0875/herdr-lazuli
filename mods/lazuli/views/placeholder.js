// A view that is not built yet, or a `view` prop lazuli does not know: a centered, muted label naming it.
// Also the base class of the stubs other slices replace.
//
// The view shape main.js expects: `new View(name)`, then `init(props, cx)`, `render(cx)`, and optionally
// `close(cx)`, `command(command, cx)` (commands routed to this view), `key(event, cx)` (the `key:` test
// hook), `focus(cx)` (Herdr gave this copy the keyboard) and, for the file view, `tab` (its own tab id).

import { t } from "../core/i18n.js";
import { tokens } from "../ui/tokens.js";
import { ViewRoot, Text } from "../ui/kit.js";

export default class Placeholder {
  constructor(name) {
    this.name = name;
  }

  init(_props, _cx) {}

  /** The muted label alone, for places that size to their content. */
  label() {
    return Text(t("common.placeholder", { view: this.name || "lazuli" }), { size: "sm", tone: "secondary", truncate: true });
  }

  render(_cx) {
    const k = tokens();
    return ViewRoot("lz-placeholder", { bg: k.bg.card }).items_center().justify_center().p(k.space.md).child(this.label().max_w_full());
  }
}
