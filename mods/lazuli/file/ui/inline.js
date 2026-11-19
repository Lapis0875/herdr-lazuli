// Markdown inline runs (core/md-tree.js) drawn as wrapped spans (spike S7, column B). Herdr's text
// wrapping breaks Hangul between any two syllables, so text with Korean (or other CJK) is drawn one
// flex item per word: a line then breaks only between words, at 어절, never inside one. A word is
// every piece between two spaces, whatever its styles ("**강조**는" stays one item). Text without CJK
// and without styles wraps natively as one element. Bold is weight, emphasis a medium weight on a
// faint accent tint (Pretendard has no italic), strike a line through, code spans the code font on
// `raised`, links the accent with an underline and a click.
//
// The word split of a run list is computed once and kept with the list (prepare), so a redraw only
// builds elements; a plain word is one element of four builder calls.

import { div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { withAlpha } from "../../ui/tokens.js";

/** Past this many words in one render, flows are drawn per styled run instead of per word (cheaper;
 *  CJK text may then break inside a word). The preview draws only the blocks on screen, so this is a
 *  guard for one enormous paragraph, not the normal case. */
export const WORD_BUDGET = 2500;
/** A word (or code span) longer than this may wrap inside itself when it does not fit the line (a
 *  long URL, path or code span); shorter ones stay on one line. A code span is always one item. */
const LONG_WORD = 40;

const CJK = /[\u1100-\u11ff\u2e80-\u9fff\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\uff00-\uffef]/;
const CJK_ALL = /[\u1100-\u11ff\u2e80-\u9fff\ua960-\ua97f\uac00-\ud7ff\uf900-\ufaff\uff00-\uffef]/g;

const isStyled = (s) => Boolean(s.bold || s.italic || s.strike || s.code || s.link);

function segments(runs, link, out) {
  for (const r of Array.isArray(runs) ? runs : []) {
    if (r?.type === "text") out.push({ text: r.text, bold: r.bold, italic: r.italic, strike: r.strike, code: r.code, link });
    else if (r?.type === "br") out.push({ br: true });
    else if (r?.type === "link") segments(r.inlines, { href: r.href, title: r.title }, out);
    else if (r?.type === "image") out.push({ image: r, link });
  }
  return out;
}

function words(segs) {
  const out = [];
  let cur = null;
  const flush = (space) => {
    if (cur) {
      cur.space = space;
      if (cur.parts.some((p) => p.text.length > LONG_WORD)) cur.long = true;
      out.push(cur);
      cur = null;
    }
  };
  for (const s of segs) {
    if (s.br) {
      flush(false);
      out.push({ br: true });
      continue;
    }
    if (s.image) {
      flush(true);
      out.push({ image: s.image, link: s.link });
      continue;
    }
    const pieces = s.code ? [s.text] : s.text.split(/( +)/);
    for (const p of pieces) {
      if (p === "") continue;
      if (/^ +$/.test(p) && !s.code) {
        flush(true);
        continue;
      }
      if (!cur) cur = { parts: [] };
      cur.parts.push({ ...s, text: p });
    }
  }
  flush(false);
  return out;
}

const prepared = new WeakMap();

/** A run list made ready to draw, kept with the list: `{plain}` (one natively wrapping text) or
 *  `{words, segs, count}`. */
export function prepare(runs) {
  const key = Array.isArray(runs) ? runs : null;
  const hit = key ? prepared.get(key) : null;
  if (hit) return hit;
  const segs = segments(runs, null, []);
  let p;
  if (segs.every((s) => !s.br && !s.image && !isStyled(s))) {
    const text = segs.map((s) => s.text).join("");
    p = CJK.test(text) ? { words: words(segs), segs } : { plain: text };
  } else p = { words: words(segs), segs };
  if (p.words) p.count = p.words.length;
  if (key) prepared.set(key, p);
  return p;
}

/** The plain text of inline runs, for headings' accessible names and alt text. */
export function plainText(runs) {
  return (Array.isArray(runs) ? runs : [])
    .map((r) => (r?.type === "text" ? r.text : r?.type === "link" ? plainText(r.inlines) : r?.type === "image" ? r.alt : " "))
    .join("");
}

const weights = new WeakMap();

/** How much room a run list's text takes, in Latin-character widths (CJK counts about twice). */
export function textWeight(runs) {
  if (!Array.isArray(runs)) return 0;
  const hit = weights.get(runs);
  if (hit !== undefined) return hit;
  const text = plainText(runs);
  const w = text.length + 0.85 * (text.match(CJK_ALL)?.length ?? 0);
  weights.set(runs, w);
  return w;
}

/** True when the runs are one picture alone (maybe inside a link): drawn as a block. */
export function lonePicture(runs) {
  const list = (Array.isArray(runs) ? runs : []).filter((r) => !(r?.type === "text" && r.text.trim() === ""));
  if (list.length !== 1) return null;
  const r = list[0];
  if (r.type === "image") return { image: r, link: null };
  if (r.type === "link") {
    const inner = lonePicture(r.inlines);
    return inner ? { image: inner.image, link: { href: r.href, title: r.title } } : null;
  }
  return null;
}

// One piece of a word: a plain one is a bare element; styles add only what they need.
function piece(p, ctx, o) {
  const el = div().flex_none();
  if (!isStyled(p)) return el.child(p.text);
  const k = ctx.k;
  let s = el;
  if (p.code) {
    s = s
      .font_family(k.fonts.mono)
      .text_size(Math.max(k.fontSize.xs, o.px - 1))
      .px(4)
      .rounded(k.radius.sm)
      .bg(k.bg.raised)
      .border_1()
      .border_color(k.line.soft);
  }
  if (p.bold) s = s.font_weight(k.weight.bold);
  else if (p.italic) s = s.font_weight(k.weight.medium);
  if (p.italic) s = s.bg(withAlpha(k.accent, 0.12)).rounded(2);
  if (p.strike) s = s.line_through().text_color(k.text.tertiary);
  if (p.link) {
    const href = p.link.href;
    s = s
      .id(ctx.uid())
      .text_color(k.accent)
      .underline()
      .cursor_pointer()
      .tooltip(p.link.title || href)
      .hover((h) => h.opacity(0.85))
      .on_click((e, cx) => ctx.link(href, e, cx));
  }
  return s.child(p.text);
}

// A long piece wraps inside itself (one element) instead of running past the line.
const wrapping = (el) => el.whitespace_normal().flex_shrink(1).min_w(0);

function word(w, ctx, o, gap) {
  if (w.parts.length === 1) {
    let el = piece(w.parts[0], ctx, o);
    if (w.long) el = wrapping(el);
    return w.space ? el.mr(gap) : el;
  }
  let row = h_flex().items_baseline().children(w.parts.map((p) => (p.text.length > LONG_WORD ? wrapping(piece(p, ctx, o)) : piece(p, ctx, o))));
  row = w.long ? row.flex_shrink(1).min_w(0) : row.flex_none();
  return w.space ? row.mr(gap) : row;
}

/** The runs as one wrapping flow. `ctx`: {k, uid() (a fresh element id), link(href, event, cx),
 *  picture(image, link) (a block element for an image), budget: {words}}. `o`: {px, lh, color,
 *  weight} for the text the flow holds. */
export function inlineFlow(runs, ctx, o) {
  const k = ctx.k;
  const p = prepare(runs);
  const style = (el) =>
    el
      .w_full()
      .min_w(0)
      .text_size(o.px)
      .line_height(`${o.lh}px`)
      .text_color(o.color ?? k.text.primary)
      .when(Boolean(o.weight), (e) => e.font_weight(o.weight));
  if (p.plain !== undefined) return style(div()).child(p.plain);
  const items = [];
  if (ctx.budget.words + p.count > WORD_BUDGET) {
    // Over budget: one item per styled run; a long run wraps inside itself.
    for (const s of p.segs) {
      if (s.br) items.push(div().w_full().h(0));
      else if (s.image) items.push(ctx.picture(s.image, s.link));
      else items.push(piece(s, ctx, o).whitespace_normal().flex_shrink(1).min_w(0));
    }
    return style(h_flex().flex_wrap().items_baseline()).children(items);
  }
  ctx.budget.words += p.count;
  const gap = Math.max(3, Math.round(o.px * 0.28));
  for (const w of p.words) {
    if (w.br) items.push(div().w_full().h(0));
    else if (w.image) items.push(ctx.picture(w.image, w.link));
    else items.push(word(w, ctx, o, gap));
  }
  return style(h_flex().flex_wrap().items_baseline().whitespace_nowrap()).children(items);
}
