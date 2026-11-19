// The native Markdown preview of a file tab (DESIGN B6, ARCHITECTURE §6): core/md-tree.js blocks drawn
// with tokens — headings, wrapped inline spans, lists with task items, tables, quotes, code blocks
// highlighted by read-only EditorStates (at most 40, made outside render, released when gone), local
// pictures through the picture cache, rules. It follows the buffer 150 ms after the last edit.
// Links: http(s) opens the browser, a relative file opens a file tab (⌘-click: a pinned one), #anchor
// scrolls to its heading.
//
// Only the rows on screen are drawn (file/ui/md-rows.js): the preview scrolls itself, each drawn row
// reports its height, and unchanged blocks keep their prepared inline data across edits, so a long
// document costs a redraw what one screen of it costs.

import { div, image } from "gpui-kit";
import { h_flex, v_flex, Editor, EditorState, TextView } from "gpui-base";
import { t } from "../core/i18n.js";
import { resolveLink, slug } from "../core/md-tree.js";
import { dirname } from "../core/paths.js";
import { entryOf, open } from "../sys/filetabs.js";
import { tokens, withAlpha } from "../ui/tokens.js";
import { Divider, Empty, Icon, IconButton, Spinner, Text } from "../ui/kit.js";
import { fenceLanguage, syntaxFor } from "./ui/lang.js";
import { inlineFlow, lonePicture, plainText } from "./ui/inline.js";
import { CODE_LINES, VScroll, buildRows, columnsOf, reuseBlocks } from "./ui/md-rows.js";
import { MdParser } from "./ui/md-parse.js";

/** The preview follows the buffer this long after the last edit. */
export const FOLLOW_MS = 150;
/** Code blocks highlighted by an EditorState at most; later ones are plain code-font text. */
export const MAX_HIGHLIGHTED = 40;
/** One parse step lexes chunks for about this long; a long file finishes over the next frames. */
export const PARSE_STEP_MS = 8;
/** Rows this far above and below the screen are drawn too, so a short scroll shows no gap. */
const MARGIN = 160;
const PAD_X = 24;
const LINE_PX = 40;
const CODE_SIZE = 12;
const CODE_LH = 19;

const HEADING = {
  1: { size: 22, lh: 28, weight: "bold" },
  2: { size: 15, lh: 22, weight: "semibold" },
  3: { size: 13, lh: 20, weight: "semibold" },
};

/** The code blocks of a tree in reading order (inside lists and quotes too). */
function codeBlocks(blocks, out = []) {
  for (const b of blocks) {
    if (b.type === "code") out.push(b);
    else if (b.type === "list") for (const item of b.items) codeBlocks(item.blocks, out);
    else if (b.type === "blockquote") codeBlocks(b.blocks, out);
  }
  return out;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class MdView {
  /** `model`: the tab's FileModel (pictures, the file and machine links resolve against);
   *  `takeKeys()`: gives the tab the keyboard (a click in the preview, for the scroll keys). */
  constructor(model, takeKeys) {
    this.model = model;
    this.takeKeys = typeof takeKeys === "function" ? takeKeys : null;
    this.text = null;
    this.pending = null;
    this.blocks = [];
    this.rows = [];
    this.anchors = new Map();
    this.states = new Map(); // code block → {state}
    this.parser = new MdParser();
    this.defsRev = 0;
    this.syntaxKey = "";
    this.timer = null;
    this.copied = null;
    this.copiedTimer = null;
    this.vs = new VScroll();
    this.view = { width: 0, height: 0 };
    this.drag = null;
  }

  /** Parses `text` (a few milliseconds of it now, the rest through step()) and brings the rows and
   *  code-block editors in line. Outside render only. */
  update(text) {
    this.pending = null;
    this.text = text;
    this.parser.begin(text);
    this.step();
  }

  /** Whether a long file still has chunks to parse: call step() soon, outside render. */
  get parsing() {
    return this.parser.busy;
  }

  /** Parses for about PARSE_STEP_MS and shows what is parsed so far. Outside render only. */
  step() {
    const r = this.parser.step(PARSE_STEP_MS);
    // Old blocks are reused only under the same reference definitions (their links resolve by them).
    const old = this.parser.defsRev === this.defsRev ? this.blocks : [];
    this.defsRev = this.parser.defsRev;
    this.blocks = reuseBlocks(old, r.blocks);
    const rows = buildRows(this.blocks);
    this.rows = rows.rows;
    this.anchors = rows.anchors;
    this.vs.setRows(this.rows);
    this.prepare();
  }

  /** The editor's text changed: the preview follows it FOLLOW_MS after the last change. */
  follow(text, cx) {
    if (text === this.text && this.pending === null) return;
    this.pending = text;
    this.timer?.cancel();
    this.timer = cx.timer.after(FOLLOW_MS, (cx) => {
      this.timer = null;
      if (this.pending !== null) this.update(this.pending);
      cx.notify();
    });
  }

  /** Whether the highlighted blocks were made with other colors than the shown theme's. */
  stale(k = tokens()) {
    return this.states.size > 0 && this.syntaxKey !== JSON.stringify(k.editorSyntax);
  }

  /** Makes, keeps and releases the code-block editors (outside render). */
  prepare() {
    const k = tokens();
    const key = JSON.stringify(k.editorSyntax);
    if (key !== this.syntaxKey) {
      for (const s of this.states.values()) s.state.release();
      this.states.clear();
      this.syntaxKey = key;
    }
    const want = new Set();
    for (const b of codeBlocks(this.blocks)) {
      if (want.size >= MAX_HIGHLIGHTED) break;
      if (want.has(b)) continue;
      want.add(b);
      if (this.states.has(b)) continue;
      const lang = fenceLanguage(b.lang);
      try {
        const state = EditorState.new({
          language: lang,
          value: b.text,
          readonly: true,
          line_numbers: false,
          folding: false,
          soft_wrap: false,
          font_family: k.fonts.mono,
          font_size: CODE_SIZE,
          syntax: syntaxFor(lang, k),
        });
        this.states.set(b, { state });
      } catch (e) {
        console.log(`[lazuli/md] code editor not made: ${e?.message ?? e}`);
      }
    }
    for (const [b, s] of [...this.states]) {
      if (!want.has(b)) {
        s.state.release();
        this.states.delete(b);
      }
    }
  }

  release() {
    this.timer?.cancel();
    this.copiedTimer?.cancel();
    for (const s of this.states.values()) s.state.release();
    this.states.clear();
  }

  // Links and moving.

  link(href, event, cx) {
    const m = this.model;
    const r = resolveLink(href, dirname(m.file));
    if (r.kind === "url") return cx.open_url(r.url);
    if (r.kind === "anchor") return this.scrollTo(r.anchor, cx);
    if (r.kind !== "file") return;
    if (r.path === m.file) {
      if (r.anchor) this.scrollTo(r.anchor, cx);
      return;
    }
    const pin = Boolean(event?.modifiers?.platform);
    open(r.path, { on: m.on, space: entryOf(m.fid)?.space, ...(pin ? { pin: true } : { preview: true }) });
  }

  /** Scrolls a heading's row to the top. */
  scrollTo(anchor, cx) {
    const id = this.anchors.has(anchor) ? anchor : slug(anchor);
    const index = this.anchors.get(id);
    if (index === undefined) return;
    this.vs.scrollToIndex(index);
    cx.notify();
  }

  scrollBy(dy, cx) {
    if (this.vs.scrollBy(dy)) cx.notify();
  }

  /** Scroll keys while the tab (not the editor) has the keyboard. True when handled. */
  key(e, cx) {
    const page = Math.max(LINE_PX, (this.vs.viewH || 400) * 0.9);
    switch (e.keystroke) {
      case "down":
        return this.scrollBy(LINE_PX, cx), true;
      case "up":
        return this.scrollBy(-LINE_PX, cx), true;
      case "pagedown":
      case "space":
        return this.scrollBy(page, cx), true;
      case "pageup":
      case "shift-space":
        return this.scrollBy(-page, cx), true;
      case "home":
      case "cmd-up":
        return this.scrollBy(-this.vs.offset(), cx), true;
      case "end":
      case "cmd-down":
        return this.scrollBy(this.vs.maxOffset() - this.vs.offset(), cx), true;
      default:
        return false;
    }
  }

  copy(key, text, cx) {
    cx.write_to_clipboard(text);
    this.copied = key;
    this.copiedTimer?.cancel();
    this.copiedTimer = cx.timer.after(1500, (cx) => {
      this.copied = null;
      cx.notify();
    });
    cx.notify();
  }

  // Drawing.

  render(_cx) {
    const k = tokens();
    let n = 0;
    const ctx = {
      k,
      uid: () => `md-${++n}`,
      link: (href, e, cx) => this.link(href, e, cx),
      picture: (img, link) => this.picture(img, link, ctx),
      budget: { words: 0 },
    };
    const root = div()
      .id("md-preview")
      .relative()
      .size_full()
      .min_w(0)
      .min_h(0)
      .overflow_hidden()
      .bg(k.bg.card)
      .accessibility_label(t("filetab.preview.label"))
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.view.width) < 1 && Math.abs(size.height - this.view.height) < 1) return;
        this.view = { width: size.width, height: size.height };
        cx.notify();
      });
    if (!this.rows.length) {
      return root.child(v_flex().size_full().justify_center().child(Empty({ id: "md-empty", icon: "file-text", title: t("filetab.md.empty") })));
    }
    // Before the first layout reports a size, a typical pane's.
    this.vs.setSize((this.view.width || 640) - 2 * PAD_X, this.view.height || 800);
    const w = this.vs.window(MARGIN);
    const drawn = [];
    for (let i = w.first; i <= w.last; i++) drawn.push(this.row(this.rows[i], ctx));
    return root
      .on_scroll_wheel((e, cx) => this.scrollBy(-(e.delta?.y ?? 0), cx))
      .on_mouse_down("left", (_e, cx) => {
        this.drag = null;
        this.takeKeys?.();
        cx.notify();
      })
      .on_mouse_move((e, cx) => this.dragMove(e, cx))
      .on_mouse_up("left", (_e, cx) => {
        if (!this.drag) return;
        this.drag = null;
        cx.notify();
      })
      .on_hover((hovered, cx) => {
        if (!hovered && this.drag) {
          this.drag = null;
          cx.notify();
        }
      })
      .child(v_flex().absolute().left(0).right(0).top(w.top).px(PAD_X).children(drawn))
      .map((e) => {
        const bar = this.thumb(k);
        return bar ? e.child(bar) : e;
      });
  }

  /** One row, wrapped to report its height. */
  row(r, ctx) {
    const color = ctx.k.text.primary;
    let content;
    if (r.kind === "item") content = this.listItem(r.block, r.item, r.index, ctx, color);
    else if (r.kind === "trow") content = this.tableRow(r.block, r.index, ctx, color);
    else content = this.block(r.block, ctx, color);
    return div()
      .id(`mdr:${r.id}`)
      .w_full()
      .flex_none()
      .when(r.gap > 0, (e) => e.pb(r.gap))
      .on_size_change((size, cx) => {
        if (this.vs.measured(r.id, size.width, size.height)) cx.notify();
      })
      .child(content);
  }

  thumb(k) {
    const vs = this.vs;
    const max = vs.maxOffset();
    const viewH = vs.viewH;
    if (max <= 0 || !this.view.height) return null;
    const track = viewH - 8;
    const size = Math.max(28, (track * viewH) / vs.total);
    const top = 4 + ((track - size) * vs.offset()) / max;
    return div()
      .id("md-thumb")
      .absolute()
      .right(3)
      .top(top)
      .w(6)
      .h(size)
      .rounded(3)
      .bg(withAlpha(k.text.tertiary, this.drag ? 0.7 : 0.4))
      .hover((s) => s.bg(withAlpha(k.text.tertiary, 0.7)))
      .on_mouse_down("left", (e, cx) => {
        this.drag = { y: e.position.y, offset: vs.offset(), per: max / Math.max(1, track - size) };
        cx.stop_propagation();
        cx.notify();
      });
  }

  dragMove(e, cx) {
    if (!this.drag) return;
    const want = clamp(this.drag.offset + (e.position.y - this.drag.y) * this.drag.per, 0, this.vs.maxOffset());
    this.scrollBy(want - this.vs.offset(), cx);
  }

  flow(runs, ctx, color, o = {}) {
    const k = ctx.k;
    return inlineFlow(runs, ctx, { px: o.px ?? k.fontSize.md, lh: o.lh ?? 21, color, weight: o.weight });
  }

  block(b, ctx, color) {
    const k = ctx.k;
    switch (b.type) {
      case "heading": {
        const h = HEADING[b.depth] ?? { size: 13, lh: 20, weight: "semibold" };
        const ink = b.depth >= 4 ? k.text.secondary : color;
        return div()
          .w_full()
          .min_w(0)
          .flex_none()
          .role("heading")
          .accessibility_label(plainText(b.inlines))
          .when(b.depth === 2, (e) => e.mt(6).pb(4).border_b(1).border_color(k.line.soft))
          .when(b.depth >= 3, (e) => e.mt(4))
          .child(this.flow(b.inlines, ctx, ink, { px: h.size, lh: h.lh, weight: k.weight[h.weight] }));
      }
      case "paragraph": {
        const lone = lonePicture(b.inlines);
        if (lone) return this.picture(lone.image, lone.link, ctx);
        return this.flow(b.inlines, ctx, color);
      }
      case "list":
        return v_flex()
          .w_full()
          .min_w(0)
          .flex_none()
          .gap(3)
          .children(b.items.map((item, i) => this.listItem(b, item, i, ctx, color)));
      case "blockquote":
        return h_flex()
          .w_full()
          .min_w(0)
          .flex_none()
          .gap(12)
          .items_stretch()
          .child(div().w(3).flex_none().rounded(2).bg(k.line.strong))
          .child(v_flex().flex_1().min_w(0).gap(6).py(2).children(b.blocks.map((c) => this.block(c, ctx, k.text.secondary))));
      case "code":
        return this.code(b, ctx);
      case "table":
        return v_flex()
          .w_full()
          .min_w(0)
          .flex_none()
          .child(this.tableRow(b, -1, ctx, color))
          .children(b.rows.map((_r, i) => this.tableRow(b, i, ctx, color)));
      case "hr":
        return Divider().my(6);
      case "html":
        return div().w_full().min_w(0).flex_none().text_color(color).child(TextView.html(ctx.uid(), b.text).selectable(true));
      default:
        return div();
    }
  }

  listItem(list, item, i, ctx, color) {
    const k = ctx.k;
    let marker;
    if (item.task) {
      marker = div()
        .size(14)
        .flex()
        .items_center()
        .justify_center()
        .rounded(k.radius.sm)
        .border(1.5)
        .border_color(item.checked ? k.accent : k.line.strong)
        .bg(item.checked ? k.accent : "#00000000")
        .text_color(k.text.onAccent)
        .accessibility_label(t(item.checked ? "filetab.md.task-done" : "filetab.md.task-open"))
        .when(item.checked, (e) => e.child(Icon("check", { size: 11 })));
    } else if (list.ordered) {
      marker = Text(`${(list.start ?? 1) + i}.`, { size: "sm", tone: "secondary", mono: true, nowrap: true });
    } else {
      marker = div().size(5).rounded(k.radius.full).bg(k.text.secondary);
    }
    const ink = item.checked ? k.text.secondary : color;
    const body = item.blocks.length ? item.blocks.map((c) => this.block(c, ctx, ink)) : [div().h(21)];
    return h_flex()
      .w_full()
      .min_w(0)
      .items_start()
      .gap(6)
      .child(h_flex().w(20).h(21).flex_none().items_center().justify_end().child(marker))
      .child(v_flex().flex_1().min_w(0).gap(4).children(body));
  }

  code(b, ctx) {
    const k = ctx.k;
    const held = this.states.get(b);
    const copied = this.copied === b;
    let body;
    if (held) {
      const lines = b.text.split("\n").length;
      body = Editor.new(held.state)
        .w_full()
        .h(Math.min(lines, CODE_LINES) * CODE_LH + 4);
    } else {
      // Past the highlighted ones: the text as one element (its line breaks are kept).
      body = div()
        .id(ctx.uid())
        .w_full()
        .overflow_x_scroll()
        .font_family(k.fonts.mono)
        .text_size(CODE_SIZE)
        .line_height(`${CODE_LH}px`)
        .text_color(k.text.primary)
        .whitespace_nowrap()
        .child(b.text === "" ? " " : b.text);
    }
    return v_flex()
      .w_full()
      .min_w(0)
      .flex_none()
      .relative()
      .px(12)
      .py(10)
      .rounded(k.radius.md)
      .bg(k.bg.surface)
      .border_1()
      .border_color(k.line.soft)
      .child(body)
      .child(
        IconButton(ctx.uid(), copied ? "check" : "copy", t(copied ? "filetab.md.copied" : "filetab.md.copy-code"), {
          size: "sm",
          onClick: (_e, cx) => this.copy(b, b.text, cx),
        })
          .absolute()
          .top(4)
          .right(4),
      );
  }

  /** One table row (`index` -1: the header), with the table's outline on its edges. */
  tableRow(b, index, ctx, color) {
    const k = ctx.k;
    const head = index < 0;
    const cells = head ? b.header : b.rows[index] ?? [];
    const last = head ? b.rows.length === 0 : index === b.rows.length - 1;
    const cols = columnsOf(b);
    const cell = (runs, i) => {
      const align = b.align[i];
      const flow = this.flow(runs ?? [], ctx, head ? k.text.secondary : color, {
        px: k.fontSize.sm,
        lh: 18,
        weight: head ? k.weight.semibold : undefined,
      });
      return div()
        .flex_1()
        .min_w(0)
        .px(10)
        .py(5)
        .when(i > 0, (e) => e.border_l(1).border_color(k.line.soft))
        .child(align === "center" ? flow.justify_center() : align === "right" ? flow.justify_end() : flow);
    };
    const children = [];
    for (let i = 0; i < cols; i++) children.push(cell(cells[i], i));
    return h_flex()
      .w_full()
      .min_w(0)
      .items_stretch()
      .border_l(1)
      .border_r(1)
      .border_b(1)
      .border_color(k.line.soft)
      .when(head, (e) => e.border_t(1).rounded_t(k.radius.md).bg(k.bg.surface))
      .when(last, (e) => e.rounded_b(k.radius.md))
      .children(children);
  }

  /** A picture: the cached copy, a placeholder while it is copied, alt text and a link for a remote
   *  one, or alt text with the reason it cannot be shown. */
  picture(img, link, ctx) {
    const k = ctx.k;
    const r = this.model.image(img.src);
    const alt = img.alt || img.title || img.src;
    const clickable = (el, href) =>
      el
        .id(ctx.uid())
        .cursor_pointer()
        .tooltip(href)
        .on_click((e, cx) => this.link(href, e, cx));
    if (r.state === "ready") {
      let el = div()
        .flex_none()
        .max_w_full()
        .rounded(8)
        .border_1()
        .border_color(k.line.soft)
        .overflow_hidden()
        .accessibility_label(alt)
        .child(image(r.path).max_w_full());
      if (link?.href) el = clickable(el, link.href);
      return el;
    }
    if (r.state === "url") {
      return clickable(
        h_flex().flex_none().max_w_full().gap(6).items_center().text_color(k.accent).child(Icon("image", { size: 14 })).child(div().underline().truncate().child(alt)),
        link?.href ?? r.url,
      );
    }
    const loading = r.state === "loading";
    return h_flex()
      .flex_none()
      .max_w_full()
      .h(32)
      .px(10)
      .gap(8)
      .items_center()
      .rounded(k.radius.md)
      .bg(k.bg.surface)
      .border_1()
      .border_dashed()
      .border_color(k.line.soft)
      .text_color(k.text.tertiary)
      .tooltip(loading ? t("filetab.image.loading") : t(`filetab.image.${r.code ?? "unreadable"}`))
      .child(loading ? Spinner({ size: 13, label: t("filetab.image.loading") }) : Icon("image", { size: 14 }))
      .child(Text(alt, { size: "sm", tone: "tertiary", truncate: true }));
  }
}
