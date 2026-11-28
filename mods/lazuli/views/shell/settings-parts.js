// Pieces of the settings view: the agent command as one line of words (quotes keep spaces inside a word), a row
// with a title and hint on the left and its control on the right, and a folder field (a path and its picker button).

import { div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { home } from "herdr";
import { tokens } from "../../ui/tokens.js";
import { Text, Field } from "../../ui/kit.js";
import { tilde } from "../apps/fmt.js";

const WORD = /"([^"]*)"|'([^']*)'|(\S+)/g;

/** A command line → its words: `claude -p "{prompt}"` → ["claude", "-p", "{prompt}"]. */
export function splitWords(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(WORD)) out.push(m[1] ?? m[2] ?? m[3]);
  return out.filter((w) => w !== "");
}

/** One word as splitWords reads it back: quoted when it holds a space or a quote. */
export function quoteWord(word) {
  const w = String(word);
  if (!/[\s"']/.test(w)) return w;
  return w.includes('"') ? `'${w}'` : `"${w}"`;
}

/** A settings row: title and hint on the left, the control on the right. */
export function settingsRow(k, { title, hint, control }) {
  return h_flex()
    .gap(16)
    .items_center()
    .child(
      v_flex()
        .flex_1()
        .min_w(0)
        .gap(2)
        .child(Text(title, { size: "sm", weight: "medium" }))
        .when(Boolean(hint), (e) => e.child(Text(hint, { size: "sm", tone: "tertiary" }))),
    )
    .child(div().flex_none().child(control));
}

/** A folder setting: the label, the path in the code font (home as `~`, `unset` when there is none) beside its
 *  picker `button`, then the hint or the error. */
export function FolderField({ id, label, path, unset, hint, error, button }) {
  const k = tokens();
  const shown = path ? tilde(path, home()) : unset;
  const box = h_flex()
    .id(`${id}-path`)
    .flex_1()
    .min_w(0)
    .h(k.control.md)
    .px(8)
    .items_center()
    .rounded(k.radius.md)
    .border_1()
    .border_color(k.line.soft)
    .bg(k.bg.surface)
    .tooltip(path ?? unset)
    .child(Text(shown, { size: "sm", mono: Boolean(path), tone: path ? "primary" : "tertiary", truncate: true }));
  return Field({ id, label, hint, error, control: h_flex().w_full().gap(8).items_center().child(box).child(div().flex_none().child(button)) });
}
