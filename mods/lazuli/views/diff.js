// A diff to read and comment on, for the Review panel (DESIGN A3; behavior of cockpit's diff.js): files that fold,
// added and removed lines on their tinted rows with the changed words marked, unified or side by side, a cursor
// moved by keys or clicks, and line comments drawn as rows of their own under their line, written in a composer
// over (or, when narrow, under) the list. Rows are a virtual list, so its clicks arrive as row keys
// (`on_item_click`): `f:<file>` folds, `l:<file>:<line>` puts the cursor there (a second click comments),
// `c:<id>` edits a comment.

import { div } from "gpui-kit";
import { h_flex, v_flex, v_virtual_list, Scrollbar, VirtualListScrollHandle } from "gpui-base";
import { t } from "../core/i18n.js";
import { tokens, withAlpha } from "../ui/tokens.js";
import { Icon, Text, Kbd, Button, TextInput } from "../ui/kit.js";
import { LARGE_NOTE } from "../sys/review.js";
import { StaleStrip } from "./panels/diff-stale.js";
import { lineNo, codeOf, sideOf, anchorAt, anchorOf } from "./panels/diff-anchor.js";

const H = { file: 32, hunk: 24, line: 20, more: 26 };

const noteText = (line) => (line[3] === LARGE_NOTE ? t("review.file.large") : line[3]);

// A text's drawn width in px at 13 px: wide (CJK) characters about 13, the rest about 7.2.
function textWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += ch.codePointAt(0) >= 0x2e80 ? 13 : 7.2;
  return w;
}

export class DiffView {
  /** `input`: an InputState made in the owner's init, `focus`: its trackFocus box; `id` keeps lists apart. */
  constructor(id, input, focus) {
    this.id = id;
    this.input = input;
    this.focusBox = focus;
    this.model = null;
    this.folded = new Set();
    this.cursor = null; // {f, l}; l null: the file's header
    this.comments = [];
    this.composer = null; // {f, l, edit: comment id | null}
    this.anchoring = null; // a stale comment's id while the reviewer picks its new line
    this.split = false;
    this.only = null; // a Set of hunk ids (a walkthrough step), else every hunk
    this.scroll = VirtualListScrollHandle.new();
    this.range = { start: 0, end: 0 };
    this.width = 400;
    this.seq = 0;
    /** A new comment's id; the Review view sets one that stays unique across diff resets. */
    this.newId = () => `${this.id}-${++this.seq}`;
    this.pressSide = null; // "left" | "right": which half of a side-by-side row the last press landed on
    /** `(path, line) => void`: open a file of the diff (`e`). */
    this.onOpen = null;
  }

  release() {
    this.scroll.release();
  }

  /** A new read: a comment stays on its line when that line still holds the code it quotes (where it was, or moved
   *  a little); otherwise it goes stale: listed above the diff, not sent, until it is moved to a line or deleted. */
  set(model) {
    const path = this.cursor && this.model?.files?.[this.cursor.f]?.path;
    this.model = model;
    const files = model?.files ?? [];
    for (const c of this.comments) {
      const f = files.findIndex((x) => x.path === c.path);
      const l = f < 0 ? -1 : anchorOf(files[f], c);
      if (l >= 0) Object.assign(c, { f, l, line: lineNo(files[f].lines[l]), stale: false });
      else Object.assign(c, { f, l: -1, stale: true });
    }
    if (this.anchoring && !this.comments.some((c) => c.id === this.anchoring && c.stale)) this.anchoring = null;
    // A comment being written follows its line by what it quotes, never by index; a line that changed under it
    // leaves the composer open (the text is kept) and the comment is made stale when it is added.
    const cmp = this.composer;
    if (cmp?.anchor) {
      const f = files.findIndex((x) => x.path === cmp.anchor.path);
      const l = f < 0 ? -1 : anchorOf(files[f], cmp.anchor);
      Object.assign(cmp, { f, l, gone: l < 0 });
      if (l >= 0) cmp.anchor.line = lineNo(files[f].lines[l]);
    }
    if (path) {
      const f = files.findIndex((x) => x.path === path);
      this.cursor = f < 0 ? null : { f, l: this.cursor.l !== null && files[f].lines[this.cursor.l] ? this.cursor.l : null };
    }
  }

  files() {
    return this.model?.files ?? [];
  }

  live() {
    return this.comments.filter((c) => !c.stale);
  }

  /** The comments as sys/review.js sends them. */
  review() {
    return this.live().map(({ path, line, old, code, text }) => ({ path, line, old, code, text }));
  }

  /** What one Send delivers: the outgoing `items`, and `sent`, a Map of each source comment's id to its revision,
   *  so only comments still unchanged after the send are removed (stale ones are never part of it). */
  batch() {
    const live = this.live();
    return {
      items: live.map(({ path, line, old, code, text }) => ({ path, line, old, code, text })),
      sent: new Map(live.map((c) => [c.id, c.rev ?? 0])),
    };
  }

  shownFile(file) {
    return !this.only || (file.hunks ?? []).some((h) => this.only.has(h.id));
  }

  visible(file, i) {
    return !this.only || (file.hunks ?? []).some((h) => this.only.has(h.id) && i >= h.at && i < h.end);
  }

  commentHeight(text) {
    const avail = Math.max(120, this.width - (this.split ? 60 : 112));
    return 44 + Math.max(1, Math.ceil(textWidth(text) / avail)) * 18;
  }

  /** Every row the list draws, with its height. */
  rows() {
    const out = [];
    this.files().forEach((file, f) => {
      if (!this.shownFile(file)) return;
      out.push({ key: `f:${f}`, h: H.file, kind: "file", f });
      if (this.folded.has(file.path)) return;
      const lines = file.lines;
      const after = (ls) => {
        for (const l of ls) for (const c of this.comments) if (c.f === f && c.l === l && !c.stale) out.push({ key: `c:${c.id}`, h: this.commentHeight(c.text), kind: "comment", f, l, c });
      };
      for (let i = 0; i < lines.length; i++) {
        if (!this.visible(file, i)) continue;
        const kind = lines[i][0];
        if (kind === "@") {
          out.push({ key: `l:${f}:${i}`, h: H.hunk, kind: "hunk", f, l: i });
          continue;
        }
        if (!this.split || (kind !== "-" && kind !== "+")) {
          out.push({ key: `l:${f}:${i}`, h: H.line, kind: "line", f, l: i });
          after([i]);
          continue;
        }
        // Side by side: a run of removed lines faces the added ones after it.
        let d = i;
        while (d < lines.length && lines[d][0] === "-") d++;
        let a = d;
        while (a < lines.length && lines[a][0] === "+") a++;
        for (let k = 0; k < Math.max(d - i, a - d); k++) {
          const left = k < d - i ? i + k : null;
          const right = k < a - d ? d + k : null;
          // Both halves in one row: the press position says which side a click meant (`pressSide`).
          out.push({ key: `p:${f}:${left ?? ""}:${right ?? ""}`, h: H.line, kind: "pair", f, l: right ?? left, left, right });
          after([left, right].filter((x) => x !== null));
        }
        i = a - 1;
      }
      if (file.more) out.push({ key: `m:${f}`, h: H.more, kind: "more", f });
    });
    return out;
  }

  /** Where the cursor stops: each file's header, then its lines (not hunk headers or notes). */
  stops() {
    const out = [];
    this.files().forEach((file, f) => {
      if (!this.shownFile(file)) return;
      out.push({ f, l: null });
      if (this.folded.has(file.path)) return;
      file.lines.forEach((ln, l) => ln[0] !== "@" && ln[0] !== "!" && this.visible(file, l) && out.push({ f, l }));
    });
    return out;
  }

  step(by) {
    const stops = this.stops();
    if (!stops.length) return;
    const at = this.cursor ? stops.findIndex((s) => s.f === this.cursor.f && s.l === this.cursor.l) : -1;
    this.cursor = stops[Math.max(0, Math.min(stops.length - 1, at < 0 ? (by > 0 ? 0 : stops.length - 1) : at + by))];
    this.reveal();
  }

  jumpFile(forward) {
    const files = this.files();
    if (!files.length) return;
    const f = this.cursor?.f ?? -1;
    this.cursor = forward ? { f: Math.min(files.length - 1, f + 1), l: null } : { f: Math.max(0, this.cursor?.l !== null ? f : f - 1), l: null };
    this.reveal();
  }

  /** The file list's click: that file unfolded, its header at the top. */
  jumpTo(f) {
    const path = this.files()[f]?.path;
    if (!path) return;
    this.folded.delete(path);
    this.cursor = { f, l: null };
    const i = this.rows().findIndex((r) => r.kind === "file" && r.f === f);
    if (i >= 0) this.scroll.scroll_to_item(i, "top");
  }

  reveal() {
    if (!this.cursor) return;
    const rows = this.rows();
    const i = rows.findIndex((r) => r.f === this.cursor.f && (this.cursor.l === null ? r.kind === "file" : r.l === this.cursor.l || r.left === this.cursor.l));
    if (i >= 0 && (i < this.range.start + 1 || i >= this.range.end - 1)) this.scroll.scroll_to_item(i, "center");
  }

  fold(f) {
    const path = this.files()[f]?.path;
    if (!path) return;
    if (!this.folded.delete(path)) this.folded.add(path);
    this.cursor = { f, l: null };
  }

  foldAll() {
    const files = this.files();
    this.folded = files.every((f) => this.folded.has(f.path)) ? new Set() : new Set(files.map((f) => f.path));
  }

  /** Opens the composer on a line (or on the comment `edit`). A new comment's line is kept as an anchor (path,
   *  side, number, quoted code and its neighbours), not as list indexes, which a refresh can shift. */
  compose(f, l, edit = null) {
    const file = this.files()[f];
    const line = file?.lines?.[l];
    if (!line || line[0] === "@" || line[0] === "!") return false;
    const anchor = edit ? null : anchorAt(file, l);
    this.cursor = { f, l };
    this.composer = { f, l, edit, anchor, gone: false };
    this.input.set_value(edit ? this.comments.find((c) => c.id === edit)?.text ?? "" : "");
    this.input.focus();
    return true;
  }

  /** The composer's text becomes a comment (or replaces the edited one); an emptied edit removes it. A new
   *  comment goes on the line its anchor finds in the diff now; when that line changed, it is added stale. */
  commit() {
    const c = this.composer;
    if (!c) return;
    const text = this.input.value().trim();
    this.composer = null;
    if (c.edit) {
      const at = this.comments.findIndex((x) => x.id === c.edit);
      if (at >= 0 && text) Object.assign(this.comments[at], { text, rev: (this.comments[at].rev ?? 0) + 1 });
      else if (at >= 0) this.comments.splice(at, 1);
      return;
    }
    if (!text || !c.anchor) return;
    const files = this.files();
    const f = files.findIndex((x) => x.path === c.anchor.path);
    const l = f < 0 ? -1 : anchorOf(files[f], c.anchor);
    const place = l >= 0 ? { f, l, line: lineNo(files[f].lines[l]), stale: false } : { f, l: -1, stale: true };
    this.comments.push({ id: this.newId(), ...c.anchor, text, rev: 1, ...place });
  }

  /** The comments whose line changed under them. */
  stale() {
    return this.comments.filter((c) => c.stale);
  }

  /** Re-anchors a stale comment on line `l` of file `f`: it now quotes that line. False on a hunk header or note. */
  moveComment(id, f, l) {
    const c = this.comments.find((x) => x.id === id);
    const file = this.files()[f];
    const line = file?.lines?.[l];
    if (!c || !line || !sideOf(line)) return false;
    Object.assign(c, { ...anchorAt(file, l), f, l, stale: false, rev: (c.rev ?? 0) + 1 });
    this.anchoring = null;
    this.cursor = { f, l };
    return true;
  }

  remove(id) {
    this.comments = this.comments.filter((c) => c.id !== id);
    if (this.composer?.edit === id) this.composer = null;
    if (this.anchoring === id) this.anchoring = null;
  }

  openCursor() {
    const file = this.cursor ? this.files()[this.cursor.f] : null;
    if (!file || !this.onOpen) return false;
    const line = this.cursor.l !== null ? file.lines[this.cursor.l] : null;
    this.onOpen(file.path, line && line[0] !== "-" ? lineNo(line) : null);
    return true;
  }

  /** A key on the diff; true when it used it. */
  key(e) {
    const key = e.keystroke;
    if (this.anchoring) {
      // Picking the line for a stale comment: arrows move, ⏎ puts it on the cursor's line, esc gives up.
      if (key === "escape") {
        this.anchoring = null;
        return true;
      }
      if (key === "enter") {
        if (this.cursor && this.cursor.l !== null) this.moveComment(this.anchoring, this.cursor.f, this.cursor.l);
        return true;
      }
    }
    if (this.composer) {
      if (key !== "escape") return false;
      this.composer = null;
      return true;
    }
    switch (key) {
      case "j": case "down": this.step(1); return true;
      case "k": case "up": this.step(-1); return true;
      case "g": case "home": this.cursor = null; this.step(1); return true;
      case "shift-g": case "end": this.step(1e9); return true;
      case "]": this.jumpFile(true); return true;
      case "[": this.jumpFile(false); return true;
      case "s": this.split = !this.split; return true;
      case "z": this.foldAll(); return true;
      case "enter":
        if (this.cursor?.l === null) this.fold(this.cursor.f);
        else if (this.cursor) this.compose(this.cursor.f, this.cursor.l);
        return Boolean(this.cursor);
      case "c": return Boolean(this.cursor && this.cursor.l !== null) && this.compose(this.cursor.f, this.cursor.l);
      case "e": return this.openCursor();
    }
    return false;
  }

  click(key) {
    const [kind, a, b, c2] = key.split(":");
    if (kind === "f") this.fold(Number(a));
    else if (kind === "l") this.clickLine(Number(a), Number(b));
    else if (kind === "p") {
      // A side-by-side row: the half that was pressed, else the side that has a line.
      const left = b === "" ? null : Number(b);
      const right = c2 === "" ? null : Number(c2);
      const l = (this.pressSide === "left" ? left : this.pressSide === "right" ? right : null) ?? right ?? left;
      this.clickLine(Number(a), l);
    } else if (kind === "c") {
      const c = this.comments.find((x) => x.id === key.slice(2));
      if (c) this.compose(c.f, c.l, c.id);
    }
  }

  /** A click on a line: places a stale comment being moved, else puts the cursor there (a second click comments). */
  clickLine(f, l) {
    if (this.anchoring) this.moveComment(this.anchoring, f, l) || (this.cursor = { f, l });
    else if (this.cursor?.f === f && this.cursor?.l === l) this.compose(f, l);
    else this.cursor = { f, l };
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Drawing. Inside the list renderer no handlers: clicks come back as row keys.

  fileRow(r, k) {
    const file = this.files()[r.f];
    const folded = this.folded.has(file.path);
    const on = this.cursor?.f === r.f && this.cursor.l === null;
    const count = this.live().filter((c) => c.path === file.path).length;
    const slash = file.path.lastIndexOf("/");
    const mono = (s) => div().font_family(k.fonts.mono).text_size(k.fontSize.xs).whitespace_nowrap().child(s);
    return h_flex()
      .h(H.file)
      .w_full()
      .px(10)
      .gap(8)
      .items_center()
      .border_t_1()
      .border_b_1()
      .border_color(k.line.soft)
      .bg(on ? k.bg.selected : k.bg.surface)
      .child(Icon(folded ? "chevron-right" : "chevron-down", { size: 12, color: k.text.tertiary }))
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .font_family(k.fonts.mono)
          .text_size(k.fontSize.sm)
          .child(div().flex_shrink_1().min_w(0).truncate().text_color(k.text.tertiary).child(slash >= 0 ? file.path.slice(0, slash + 1) : ""))
          .child(div().flex_none().font_weight(k.weight.semibold).text_color(k.text.primary).child(file.path.slice(slash + 1))),
      )
      .when(count > 0, (e) => e.child(h_flex().gap(3).items_center().text_color(k.accent).child(Icon("message-square", { size: 12 })).child(mono(String(count)))))
      .child(mono(`+${file.added}`).text_color(k.diff.add))
      .child(mono(`−${file.removed}`).text_color(k.diff.remove));
  }

  pieces(line, k, tint) {
    const text = codeOf(line);
    const marks = line[4];
    if (!marks?.length || !tint) return [div().child(text || " ")];
    const out = [];
    let at = 0;
    for (const [s, e] of marks) {
      if (s > at) out.push(div().child(text.slice(at, s)));
      out.push(div().rounded(2).bg(withAlpha(tint, 0.32)).child(text.slice(s, e)));
      at = e;
    }
    if (at < text.length) out.push(div().child(text.slice(at)));
    return out;
  }

  /** One side of a line. `side` "old" | "new" picks the gutter number (a context line has both: old on the left
   *  half of a side-by-side row, new on the right); omitted, the line's own number. */
  half(line, l, f, k, gutter, cursorOn, side) {
    const kind = line?.[0] ?? " ";
    const tint = kind === "+" ? k.diff.add : kind === "-" ? k.diff.remove : null;
    const commented = l !== null && this.comments.some((c) => c.f === f && c.l === l && !c.stale);
    return h_flex()
      .flex_1()
      .min_w(0)
      .h_full()
      .items_center()
      .when(Boolean(tint), (e) => e.bg(kind === "+" ? k.diff.addBg : k.diff.removeBg))
      .when(!line, (e) => e.bg(withAlpha(k.bg.surface, 0.6)))
      .child(
        h_flex()
          .w(gutter)
          .flex_none()
          .h_full()
          .items_center()
          .justify_end()
          .pr(6)
          .gap(4)
          .font_family(k.fonts.mono)
          .text_size(k.fontSize.xs)
          .text_color(cursorOn ? k.text.primary : k.text.tertiary)
          .when(Boolean(tint), (e) => e.bg(withAlpha(tint, 0.08)))
          .when(commented, (e) => e.child(div().size(5).flex_none().rounded(k.radius.full).bg(k.accent)))
          .child(line ? String((side === "old" ? line[1] : side === "new" ? line[2] : lineNo(line)) ?? "") : ""),
      )
      .child(div().w(14).flex_none().text_center().font_family(k.fonts.mono).text_size(k.fontSize.sm).text_color(tint ?? k.text.tertiary).child(kind === "-" ? "−" : kind === "+" ? "+" : ""))
      .child(
        h_flex()
          .flex_1()
          .min_w(0)
          .overflow_hidden()
          .whitespace_nowrap()
          .font_family(k.fonts.mono)
          .text_size(k.fontSize.sm)
          .text_color(k.text.primary)
          .children(line ? this.pieces(line, k, tint) : []),
      );
  }

  lineRow(r, k) {
    const file = this.files()[r.f];
    const at = this.cursor?.f === r.f ? this.cursor.l : undefined;
    const on = at !== undefined && (at === r.l || (r.kind === "pair" && (at === r.left || at === r.right)));
    let row = h_flex().h(H.line).w_full().relative();
    if (r.kind === "hunk") {
      return row.h(H.hunk).px(10).items_center().bg(withAlpha(k.accent, 0.06)).font_family(k.fonts.mono).text_size(k.fontSize.xs).text_color(k.text.secondary).child(div().min_w(0).truncate().child(codeOf(file.lines[r.l])));
    }
    if (r.kind === "pair") {
      row = row
        .child(this.half(r.left !== null ? file.lines[r.left] : null, r.left, r.f, k, 40, on && at === r.left))
        .child(div().w(1).h_full().bg(k.line.soft))
        .child(this.half(r.right !== null ? file.lines[r.right] : null, r.right, r.f, k, 40, on && at === r.right));
    } else {
      const line = file.lines[r.l];
      if (line[0] === "!") return row.px(10).items_center().text_size(k.fontSize.xs).text_color(k.text.tertiary).child(div().min_w(0).truncate().child(noteText(line)));
      row = this.split && line[0] === " "
        ? row.child(this.half(line, r.l, r.f, k, 40, on, "old")).child(div().w(1).h_full().bg(k.line.soft)).child(this.half(line, null, r.f, k, 40, on, "new"))
        : row.child(this.half(line, r.l, r.f, k, 44, on));
    }
    if (on) row = row.child(div().absolute().inset_0().bg(withAlpha(k.accent, 0.08))).child(div().absolute().left(0).top(0).bottom(0).w(2).bg(k.accent));
    return row;
  }

  commentRow(r, k) {
    const c = r.c;
    const editing = this.composer?.edit === c.id;
    return div().h(r.h).w_full().px(10).py(4).child(
      v_flex()
        .size_full()
        .overflow_hidden()
        .ml(this.split ? 0 : 58)
        .p(8)
        .gap(4)
        .rounded(k.radius.md)
        .border_1()
        .border_color(editing ? k.accent : withAlpha(k.accent, 0.45))
        .bg(withAlpha(k.accent, 0.06))
        .child(
          h_flex()
            .gap(6)
            .items_center()
            .text_size(k.fontSize.xs)
            .text_color(k.text.secondary)
            .child(Icon("message-square", { size: 12, color: k.accent }))
            .child(div().flex_1().min_w(0).truncate().child(t(c.old ? "review.comment.lineRemoved" : "review.comment.line", { line: c.line })))
            .child(div().flex_none().text_color(k.text.tertiary).child(t(editing ? "review.comment.editing" : "review.comment.clickToEdit"))),
        )
        .child(Text(c.text, { size: "sm" })),
    );
  }

  moreRow(r, k) {
    return h_flex().h(H.more).w_full().px(10).items_center().text_size(k.fontSize.xs).text_color(k.text.tertiary).child(t("review.diff.more", { count: this.files()[r.f].more }));
  }

  /** The composer: floating over the list's top right, or docked under it when narrow. */
  composerCard(k, narrow) {
    const c = this.composer;
    // What the comment is about: the anchor taken when composing (or the comment edited), never list indexes.
    const a = c.edit ? this.comments.find((x) => x.id === c.edit) : c.anchor;
    if (!a) return null;
    const stop = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());
    const card = v_flex()
      .id(`${this.id}-composer`)
      .gap(8)
      .p(12)
      .rounded(k.radius.lg)
      .border_1()
      .border_color(k.accent)
      .bg(k.bg.popover)
      .shadow_md()
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(Icon("message-square-plus", { size: 14, color: k.accent }))
          .child(Text(`${a.path.split("/").pop()}:${a.line}`, { size: "sm", weight: "semibold", truncate: true })),
      )
      .child(div().px(8).py(3).rounded(k.radius.sm).bg(k.bg.raised).font_family(k.fonts.mono).text_size(k.fontSize.xs).text_color(k.text.secondary).truncate().child(String(a.code ?? "").trim() || " "))
      .when(Boolean(c.gone), (e) => e.child(Text(t("review.comment.lineGone"), { size: "xs", tone: "warning" }).role("alert")))
      .child(TextInput(this.input, { id: `${this.id}-comment`, focused: this.focusBox?.focused, a11y: t("review.comment.field") }))
      .child(
        h_flex()
          .gap(6)
          .items_center()
          .child(h_flex().gap(4).items_center().text_size(k.fontSize.xs).text_color(k.text.tertiary).child(Kbd("⏎")).child(t("review.comment.add")).child(Kbd("esc")).child(t("common.cancel")))
          .child(div().flex_1())
          .when(Boolean(c.edit), (e) => e.child(Button(`${this.id}-del`, t("common.delete"), { variant: "ghost", size: "sm", onClick: (_e, cx) => { this.remove(c.edit); cx.notify(); } })))
          .child(Button(`${this.id}-cancel`, t("common.cancel"), { size: "sm", onClick: (_e, cx) => { this.composer = null; cx.notify(); } }))
          .child(Button(`${this.id}-add`, t(c.edit ? "common.save" : "review.comment.add"), { variant: "primary", size: "sm", onClick: (_e, cx) => { this.commit(); cx.notify(); } })),
      );
    return stop(narrow ? card.mx(8).mb(8).flex_none() : card.absolute().top(8).right(12).w(340));
  }

  /** The list filling its column, its composer over or under it. */
  render({ narrow = false } = {}) {
    const k = tokens();
    const rows = this.rows();
    const list = v_virtual_list(`${this.id}-rows`, rows.length, rows.map((r) => r.h), (i) => rows[i].key, (range) => {
      this.range = range;
      return rows.slice(range.start, range.end).map((r) =>
        r.kind === "file" ? this.fileRow(r, k) : r.kind === "comment" ? this.commentRow(r, k) : r.kind === "more" ? this.moreRow(r, k) : this.lineRow(r, k),
      );
    })
      .track_scroll(this.scroll)
      .size_full()
      .on_item_click((key, cx) => {
        this.click(key);
        cx.notify();
      });
    const box = div()
      .id(`${this.id}-box`)
      .relative()
      .flex_1()
      .min_h(0)
      .w_full()
      .overflow_hidden()
      // Which half of a side-by-side row a press lands on: the row click (on_item_click) reports only the row.
      .on_mouse_down("left", (e) => {
        const x = e?.local_position?.x;
        this.pressSide = x == null || !this.split ? null : x < this.width / 2 ? "left" : "right";
      })
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) > 1) {
          this.width = size.width;
          cx.notify();
        }
      })
      .child(list)
      .child(Scrollbar.vertical(`${this.id}-rows`).viewport_from_layout().absolute().inset_0());
    const composer = this.composer ? this.composerCard(k, narrow) : null;
    const strip = this.stale().length ? StaleStrip(this, k) : null;
    const body = !composer ? box : narrow ? v_flex().flex_1().min_h(0).w_full().child(box).child(composer) : box.child(composer);
    return strip ? v_flex().flex_1().min_h(0).w_full().child(strip).child(body) : body;
  }
}
