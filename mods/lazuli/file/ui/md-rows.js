// The Markdown preview as a column of rows drawn only near the screen (DESIGN B6): a document's
// blocks become rows (a list item, a table row and every other top-level block is one row), each row
// has an estimated height until it was drawn and measured, and VScroll keeps the scroll position as
// "this row, this far into it", so heights learned above the screen never move what is shown.
// No host calls: md-view.js feeds it sizes and draws the rows it names.

import { textWeight, lonePicture } from "./inline.js";

/** Space below a top-level block, between list items, and between table rows. */
export const GAP = 10;
const ITEM_GAP = 3;
/** The preview's padding above the first and below the last row. */
export const PAD_TOP = 18;
export const PAD_BOTTOM = 32;
/** Latin characters per pixel of width at the body size (13 px Pretendard). */
const CHAR_PX = 7.2;
const BODY_LH = 21;
const CODE_LH = 19;
/** A highlighted code block shows at most this many lines before it scrolls inside. */
export const CODE_LINES = 30;
const HEADING = { 1: [28, 0], 2: [22, 11], 3: [20, 4] };

const lines = (weight, width) => Math.max(1, Math.ceil(weight / Math.max(8, width / CHAR_PX)));
const isPlain = (v) => v !== null && typeof v === "object";

/** Heading ids inside a block, joined (a reused block must keep the same ones). */
export function headingIds(b) {
  if (!isPlain(b)) return "";
  if (b.type === "heading") return b.id;
  if (b.type === "list") return b.items.map((it) => it.blocks.map(headingIds).join(",")).join(";");
  if (b.type === "blockquote") return b.blocks.map(headingIds).join(",");
  return "";
}

/** The new tree with every unchanged top-level block replaced by the old object (same source, heading
 *  ids, list start and continuation), so what was prepared for it is kept. Repeated blocks match old
 *  ones one to one. */
export function reuseBlocks(old, fresh) {
  const byKey = new Map();
  for (const b of old) {
    const list = byKey.get(b.key);
    if (list) list.push(b);
    else byKey.set(b.key, [b]);
  }
  const same = (o, b) =>
    o.type === b.type && (o.start ?? null) === (b.start ?? null) && Boolean(o.cont) === Boolean(b.cont) && headingIds(o) === headingIds(b);
  return fresh.map((b) => {
    const list = byKey.get(b.key);
    const o = list?.[0];
    if (!o || !same(o, b)) return b;
    list.shift();
    return o;
  });
}

function collectHeadings(blocks, row, anchors) {
  for (const b of blocks) {
    if (b.type === "heading") {
      if (!anchors.has(b.id)) anchors.set(b.id, row);
    } else if (b.type === "list") for (const it of b.items) collectHeadings(it.blocks, row, anchors);
    else if (b.type === "blockquote") collectHeadings(b.blocks, row, anchors);
  }
}

/** The rows of a tree: `{rows: [{id, kind: "block"|"item"|"trow", block, index, item?, gap}],
 *  anchors: Map(heading id → row index)}`. Row ids come from the source hash, so a row keeps its id
 *  (and its measured height) while other parts of the file change. */
export function buildRows(blocks) {
  const rows = [];
  const anchors = new Map();
  const seen = new Map();
  const idOf = (base) => {
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}~${n}` : base;
  };
  blocks.forEach((b, at) => {
    if (b.type === "list" && b.items.length) {
      // A list the parser cut in two (`cont` on the second part) keeps item spacing across the cut.
      const goesOn = blocks[at + 1]?.type === "list" && blocks[at + 1].cont === true;
      b.items.forEach((item, i) => {
        rows.push({ id: idOf(`${b.key}/${i}`), kind: "item", block: b, item, index: i, gap: i === b.items.length - 1 && !goesOn ? GAP : ITEM_GAP });
        collectHeadings(item.blocks, rows.length - 1, anchors);
      });
    } else if (b.type === "table") {
      const n = b.rows.length;
      rows.push({ id: idOf(`${b.key}/h`), kind: "trow", block: b, index: -1, gap: n ? 0 : GAP });
      for (let i = 0; i < n; i++) rows.push({ id: idOf(`${b.key}/${i}`), kind: "trow", block: b, index: i, gap: i === n - 1 ? GAP : 0 });
    } else {
      rows.push({ id: idOf(b.key), kind: "block", block: b, index: 0, gap: GAP });
      collectHeadings([b], rows.length - 1, anchors);
    }
  });
  return { rows, anchors };
}

const columns = new WeakMap();

/** A table's column count (kept with the table). */
export function columnsOf(t) {
  let n = columns.get(t);
  if (n === undefined) {
    n = Math.max(t.header.length, ...t.rows.map((r) => r.length), 1);
    columns.set(t, n);
  }
  return n;
}

function tableRowHeight(t, index, width) {
  const cells = index < 0 ? t.header : t.rows[index] ?? [];
  const cellWidth = width / columnsOf(t) - 20;
  let most = 1;
  for (const c of cells) most = Math.max(most, lines(textWeight(c) * 0.93, cellWidth));
  return most * 18 + 11 + (index < 0 ? 1 : 0);
}

function blocksHeight(blocks, width, gap) {
  let h = 0;
  blocks.forEach((b, i) => {
    h += blockHeight(b, width) + (i ? gap : 0);
  });
  return h;
}

function blockHeight(b, width) {
  switch (b.type) {
    case "heading": {
      const [lh, extra] = HEADING[b.depth] ?? [20, 4];
      return lines(textWeight(b.inlines) * (lh / BODY_LH), width) * lh + extra;
    }
    case "paragraph":
      return lonePicture(b.inlines) ? 200 : lines(textWeight(b.inlines), width) * BODY_LH;
    case "code":
      return Math.min(b.text.split("\n").length, CODE_LINES) * CODE_LH + 24;
    case "list":
      return b.items.reduce((h, it, i) => h + (i ? ITEM_GAP : 0) + Math.max(BODY_LH, blocksHeight(it.blocks, width - 26, 4)), 0);
    case "blockquote":
      return blocksHeight(b.blocks, width - 15, 6) + 4;
    case "table":
      return tableRowHeight(b, -1, width) + b.rows.reduce((h, _r, i) => h + tableRowHeight(b, i, width), 0);
    case "hr":
      return 13;
    case "html":
      return 40;
    default:
      return BODY_LH;
  }
}

/** A row's height before it is measured, gap included. */
export function estimateRow(row, width) {
  if (row.kind === "item") return Math.max(BODY_LH, blocksHeight(row.item.blocks, width - 26, 4)) + row.gap;
  if (row.kind === "trow") return tableRowHeight(row.block, row.index, width) + row.gap;
  return blockHeight(row.block, width) + row.gap;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** A vertical scroller over rows of unknown height. Sizes come from setSize() and measured(); the
 *  position is kept as a row id plus the distance into it. */
export class VScroll {
  constructor(estimate = estimateRow) {
    this.estimate = estimate;
    this.rows = [];
    this.index = new Map();
    this.sizes = new Map(); // row id → {w, h}
    this.width = 0;
    this.viewH = 0;
    this.tops = null;
    this.total = 0;
    this.anchorId = null;
    this.delta = 0;
  }

  setRows(rows) {
    const offset = this.rows.length ? this.offset() : 0;
    const keep = this.anchorId;
    this.rows = rows;
    this.index = new Map(rows.map((r, i) => [r.id, i]));
    for (const id of [...this.sizes.keys()]) if (!this.index.has(id)) this.sizes.delete(id);
    this.tops = null;
    if (!keep || !this.index.has(keep)) this.setOffset(offset);
  }

  /** The rows' width and the visible height. A new width makes every measurement an estimate again. */
  setSize(width, height) {
    const w = Math.round(width);
    if (w !== this.width) {
      this.width = w;
      this.tops = null;
    }
    this.viewH = height;
  }

  /** A drawn row's size. True when it changed what is known. */
  measured(id, width, height) {
    const w = Math.round(width);
    const prev = this.sizes.get(id);
    if (prev && prev.w === w && Math.abs(prev.h - height) < 0.5) return false;
    this.sizes.set(id, { w, h: height });
    if (w === this.width && this.index.has(id)) this.tops = null;
    return true;
  }

  heightAt(i) {
    const r = this.rows[i];
    const s = this.sizes.get(r.id);
    return s && s.w === this.width ? s.h : this.estimate(r, this.width);
  }

  layout() {
    if (this.tops) return;
    const n = this.rows.length;
    const tops = new Array(n + 1);
    let y = PAD_TOP;
    for (let i = 0; i < n; i++) {
      tops[i] = y;
      y += this.heightAt(i);
    }
    tops[n] = y;
    this.tops = tops;
    this.total = y + PAD_BOTTOM;
  }

  maxOffset() {
    this.layout();
    return Math.max(0, this.total - this.viewH);
  }

  /** The last row whose top is at or above `y`. */
  indexAt(y) {
    this.layout();
    let lo = 0;
    let hi = this.rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.tops[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    return Math.max(0, lo);
  }

  offset() {
    this.layout();
    const i = this.anchorId === null ? undefined : this.index.get(this.anchorId);
    return clamp((i === undefined ? 0 : this.tops[i]) + this.delta, 0, this.maxOffset());
  }

  setOffset(y) {
    const off = clamp(y, 0, this.maxOffset());
    if (!this.rows.length) {
      this.anchorId = null;
      this.delta = off;
      return;
    }
    const i = this.indexAt(off);
    this.anchorId = this.rows[i].id;
    this.delta = off - this.tops[i];
  }

  /** Scrolls by `dy` px; true when the position moved. */
  scrollBy(dy) {
    const before = this.offset();
    this.setOffset(before + dy);
    return Math.abs(this.offset() - before) >= 0.5;
  }

  /** Puts a row at the top, a little below the edge. */
  scrollToIndex(i) {
    this.layout();
    if (i < 0 || i >= this.rows.length) return;
    this.setOffset(this.tops[i] - 8);
  }

  /** The rows to draw: `{first, last, top}`, `top` being where row `first` starts on screen. */
  window(margin) {
    const off = this.offset();
    if (!this.rows.length) return { first: 0, last: -1, top: PAD_TOP - off, offset: off };
    const first = this.indexAt(off - margin);
    const last = this.indexAt(off + this.viewH + margin);
    return { first, last, top: this.tops[first] - off, offset: off };
  }
}
