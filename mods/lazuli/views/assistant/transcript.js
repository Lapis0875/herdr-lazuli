// The chat's transcript: the rows of core/assistant-chat.js `rows` (items in order, each approval card after the item
// that was last when it arrived), virtualized with the markdown preview's scroller (file/ui/md-rows.js VScroll): only
// the rows on screen and a margin are built, each drawn row reports its height, and the rest stand at an estimate, so
// a 2,000-item transcript (K5 rule 9, AT-22) costs a redraw what one screen costs. It follows the stream: new content
// stays in view unless the person scrolled up; the wheel, End and "Jump to latest" move it. A short transcript starts
// at the top. Scroll state is kept per session.

import { div } from "gpui-kit";
import { v_flex } from "gpui-base";
import { t } from "../../core/i18n.js";
import { tokens, withAlpha } from "../../ui/tokens.js";
import { Button } from "../../ui/kit.js";
import { rows as chatRows } from "../../core/assistant-chat.js";
import { VScroll } from "../../file/ui/md-rows.js";
import { UserItem, AgentText, ThoughtItem, ToolCard, ApprovalCard, NoticeItem, noticeBody } from "./cards.js";

const PAD_X = 16;
const GAP = 12;
// Rows this far above and below the screen are built too, so a short scroll shows no gap.
const MARGIN = 400;
const LINE = 40;
// How close to the end counts as at the end (a wheel tick rarely lands exactly on it).
const SLACK = 6;
const BODY_LH = 20;
const SMALL_LH = 18;

/** Rows of text a string takes at `width` px (about 7.5 px a Latin character, 13 px for a Hangul syllable). */
function lines(text, width, px = 7.5) {
  const per = Math.max(16, Math.floor(width / px));
  let n = 0;
  for (const line of String(text ?? "").split("\n")) n += Math.max(1, Math.ceil(line.length / per));
  return n;
}

/** A row's height before it is drawn, its gap included. */
function estimate(r, width) {
  const w = Math.max(200, width);
  const it = r.row;
  switch (it.type) {
    case "user":
      return 18 + lines(it.text, w - 24) * BODY_LH + (it.via === "steer" || it.via === "queue" ? 22 : 0) + (it.attachments?.length ? 26 : 0) + GAP;
    case "assistant":
      return lines(it.text, w, 8) * 22 + 6 + GAP;
    case "thought":
      return 28 + (r.open ? lines(it.text, w - 24) * SMALL_LH + 12 : 0) + GAP;
    case "tool":
      return 34 + (r.open ? 220 : 0) + GAP;
    case "permission":
      return (it.state === "answered" ? 26 : 150 + (it.content?.some((c) => c?.type === "diff") ? 160 : 0)) + GAP;
    case "notice": {
      // A long detail (an agent's error) wraps under the notice, with Show all when it is clamped.
      const body = noticeBody(it, r.open);
      if (!body || body.inline) return 22 + GAP;
      return 22 + 2 + lines(body.text, w - 24, body.words ? 7.5 : 7) * (body.words ? BODY_LH : 16) + (body.more ? 26 : 0) + GAP;
    }
    default:
      return 22 + GAP;
  }
}

/** One session's scroll: the scroller over its rows, whether it follows the end, and the body's measured size. */
function scrollState() {
  return { vs: new VScroll(estimate), follow: true, view: { width: 0, height: 0 } };
}

/** Every session's scroll in a view. */
export class Scrolls {
  constructor() {
    this.byKey = new Map();
  }

  of(key) {
    if (!this.byKey.has(key)) this.byKey.set(key, scrollState());
    return this.byKey.get(key);
  }

  /** Moves by dy (down positive); at the end it follows again, anywhere above it stops following. */
  by(key, dy) {
    const s = this.of(key);
    s.vs.scrollBy(dy);
    s.follow = s.vs.offset() >= s.vs.maxOffset() - SLACK;
  }

  /** End follows, Home goes to the top, Page Up and Down move. True when it was one of them. */
  key(key, keystroke) {
    const s = this.of(key);
    if (keystroke === "end") {
      s.follow = true;
      return true;
    }
    if (keystroke === "home") {
      s.follow = false;
      s.vs.setOffset(0);
      return true;
    }
    const page = Math.max(LINE, s.view.height * 0.9);
    const dy = { pagedown: page, pageup: -page }[keystroke];
    if (dy === undefined) return false;
    this.by(key, dy);
    return true;
  }
}

/** A row's stable id: items by `seq`, cards by request id. */
const rowId = (r) => (r.type === "permission" ? `p:${r.requestId}` : `i:${r.seq}`);

/** The element for one row. */
function rowElement(view, chat, r, now) {
  const id = `ac-i-${r.seq}`;
  switch (r.type) {
    case "permission":
      return ApprovalCard(view, chat, r, now);
    case "user":
      return UserItem(id, r);
    case "assistant":
      return AgentText(`ac-md-${chat.key}-${r.seq}`, r);
    case "thought":
      return ThoughtItem(view, chat, `thought:${r.seq}`, r);
    case "tool":
      return ToolCard(view, chat, `tool:${r.id}`, r, now);
    case "notice":
      return NoticeItem(view, chat, id, r);
    default:
      return null;
  }
}

/** The transcript body of `chat`, virtualized; the content dims while the session is stale (K5 rule 8). */
export function Transcript(view, chat, now) {
  const k = tokens();
  const s = view.scrolls.of(chat.key);
  const vs = s.vs;
  const rows = chatRows(chat).map((row) => {
    const id = rowId(row);
    const open =
      row.type === "tool"
        ? view.isOpen(chat.key, `tool:${row.id}`)
        : row.type === "thought"
          ? view.isOpen(chat.key, `thought:${row.seq}`)
          : row.type === "notice"
            ? view.isOpen(chat.key, `notice:${row.seq}`)
            : false;
    return { id, row, open };
  });
  vs.setRows(rows);
  // Before the first layout reports a size, a typical block's.
  vs.setSize((s.view.width || 600) - 2 * PAD_X, s.view.height || 600);
  if (s.follow) vs.setOffset(vs.maxOffset());
  const w = vs.window(MARGIN);
  const drawn = [];
  for (let i = w.first; i <= w.last; i++) {
    const r = rows[i];
    const el = rowElement(view, chat, r.row, now);
    if (!el) continue;
    drawn.push(
      div()
        .id(`ac-row-${r.id}`)
        .w_full()
        .flex_none()
        .pb(GAP)
        .on_size_change((size, cx) => {
          if (vs.measured(r.id, size.width, size.height)) cx.notify();
        })
        .child(el),
    );
  }
  const max = vs.maxOffset();
  const viewH = vs.viewH;
  const thumbH = max > 0 && vs.total > 0 ? Math.max(24, (viewH * viewH) / vs.total) : 0;
  const thumbTop = max > 0 ? 4 + ((viewH - 8 - thumbH) * vs.offset()) / max : 0;
  return div()
    .id(`ac-body-${chat.key}`)
    .relative()
    .flex_1()
    .min_h(0)
    .w_full()
    .overflow_hidden()
    .role("log")
    .accessibility_label(chat.title || t("assistant.list.untitled"))
    .on_size_change((size, cx) => {
      if (Math.abs(size.width - s.view.width) < 1 && Math.abs(size.height - s.view.height) < 1) return;
      s.view = { width: size.width, height: size.height };
      cx.notify();
    })
    .on_scroll_wheel((e, cx) => {
      view.scrolls.by(chat.key, -(e.delta?.y ?? 0));
      cx.notify();
    })
    .child(
      v_flex()
        .id(`ac-content-${chat.key}`)
        .absolute()
        .left(0)
        .right(0)
        .top(w.top)
        .px(PAD_X)
        .when(Boolean(chat.stale), (e) => e.opacity(0.7))
        .children(drawn),
    )
    .when(max > 0, (e) => e.child(div().absolute().right(3).w(4).rounded(2).bg(withAlpha(k.text.secondary, 0.35)).top(thumbTop).h(thumbH)))
    .when(!s.follow && max > SLACK, (e) =>
      e.child(
        div()
          .absolute()
          .bottom(10)
          .right(PAD_X)
          .child(
            Button("ac-latest", t("assistant.chat.latest"), {
              size: "sm",
              icon: "arrow-down",
              tooltip: t("assistant.chat.latestHint"),
              onClick: (_e, cx) => {
                s.follow = true;
                cx.notify();
              },
            }),
          ),
      ),
    );
}
