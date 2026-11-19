// A PDF in a file tab (DESIGN B9): continuous vertical scroll over pages pdfd (or pdftocairo) renders as
// JPEGs under the app home, the visible pages ±2 asked for through PdfClient.want(). Fixed zoom steps
// (fit width, 50–200 %), page jump, outline panel, search with the hits drawn on the pages and
// next/previous, link areas (a page in this file, or the browser), "Copy page text", and the
// preparing / failed / fallback states with Retry and "Open in Preview".
//
// The page area scrolls itself: the wheel moves an offset this view keeps, so it always knows which
// pages show and where a link or hit sits on screen (a lazy list would forbid per-page click handlers).

import { div, image } from "gpui-kit";
import { h_flex, v_flex, InputState } from "gpui-base";
import { checking } from "herdr";
import { t } from "../core/i18n.js";
import { PDF_ZOOMS } from "../sys/state.js";
import { debugLog, settings as lazuliSettings } from "../sys/store.js";
import { openInPreview } from "../sys/sidecars.js";
import { tokens, withAlpha } from "../ui/tokens.js";
import { Button, Spinner, Text } from "../ui/kit.js";
import { PdfClient } from "./pdf-client.js";
import { outlinePanel, pdfStatus, pdfToolbar } from "./ui/pdf-bar.js";

/** Pixels per point drawn: macOS screens are 2×. */
const DPR = 2;
/** Render widths are rounded up to this many device pixels, so resizing a pane does not render anew
 *  for every pixel. */
const WIDTH_STEP = 100;
const PAD = 16;
const GAP = 12;
const LINE = 48;
/** A point size for pages the daemon did not report. */
const LETTER = [612, 792];
/** The page area's size until its first layout reports one (a typical center tab, logical px). */
const FALLBACK = Object.freeze({ width: 900, height: 700 });

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class PdfView {
  /** Made outside render (focus handle, inputs); starts the client unless checking. */
  constructor(file, cx) {
    this.file = file;
    this.pdf = new PdfClient(file);
    this.handle = cx.focus_handle();
    this.searchInput = InputState.new({ placeholder: t("filetab.pdf.search-placeholder") });
    this.pageInput = InputState.new({ placeholder: t("filetab.pdf.page-input") });
    const z = lazuliSettings().pdf?.zoom;
    this.zoom = PDF_ZOOMS.includes(z) ? z : "fit";
    this.offY = 0;
    this.offX = 0;
    this.view = { width: 0, height: 0 };
    this.doc = null;
    this.outlineOpen = false;
    this.outline = null; // null: not asked; {busy} | {items} | {error}
    this.links = new Map();
    this.linksPending = new Set();
    this.linksTimer = null;
    this.search = { query: "", hits: [], index: -1, busy: false, truncated: false, error: null };
    this.copy = null; // {state: "busy"|"done"|"empty"|"failed", page}
    this.copyTimer = null;
    this.editingPage = false;
    this.drag = null;
    this.pendingPage = null;
    this.attached = new Map(); // page → "path w×h" last drawn (for the debug log)
    this.wantOutline = false;
    this.searchInput.on("submit", (e, cx) => this.runSearch(e?.shift ? -1 : 1, cx));
    this.pageInput.on("submit", (_e, cx) => this.jumpFromInput(cx));
    this.pageInput.on("blur", (_e, cx) => {
      this.editingPage = false;
      cx.notify();
    });
    if (checking()) return;
    cx.spawn(async (cx) => this.pdf.run(cx));
    cx.spawn(async (cx) => {
      while (this.pdf.state !== "closed") {
        await this.pdf.changes();
        if (this.pdf.info?.doc !== this.doc) this.opened();
        cx.notify();
      }
    });
  }

  /** A new document (first open, a reload): what was asked about the old one goes. */
  opened() {
    this.doc = this.pdf.info?.doc ?? null;
    this.links.clear();
    this.linksPending.clear();
    this.outline = null;
    this.search = { query: "", hits: [], index: -1, busy: false, truncated: false, error: null };
    if (this.doc && this.outlineOpen && this.pdf.info.hasOutline) this.wantOutline = true;
  }

  dispose() {
    this.pdf.dispose();
    this.linksTimer?.cancel();
    this.copyTimer?.cancel();
    this.searchInput.release?.();
    this.pageInput.release?.();
    this.handle.release?.();
  }

  /** Search, links and the outline: only the daemon has them (not pdftocairo). */
  get full() {
    return this.pdf.mode === "pdfd";
  }

  // Geometry: page boxes in content pixels for the shown zoom and width.

  layout() {
    const info = this.pdf.info;
    if (!info || !this.view.width) return null;
    const avail = Math.max(120, this.view.width - 2 * PAD);
    const boxes = [];
    let y = PAD;
    let widest = 0;
    for (let i = 0; i < info.pages; i++) {
      const [w, h] = Array.isArray(info.sizes[i]) ? info.sizes[i] : (info.sizes[0] ?? LETTER);
      const s = this.zoom === "fit" ? avail / (w || 1) : this.zoom / 100;
      const box = { page: i + 1, top: y, width: Math.max(1, w * s), height: Math.max(1, h * s) };
      boxes.push(box);
      widest = Math.max(widest, box.width);
      y += box.height + GAP;
    }
    return { boxes, height: y - GAP + PAD, width: widest + 2 * PAD, widest };
  }

  maxY(l) {
    return Math.max(0, l.height - this.view.height);
  }

  maxX(l) {
    return Math.max(0, l.width - this.view.width);
  }

  /** The pages any part of which shows: [first, last] (1-based), or null. */
  visible(l) {
    let first = null;
    let last = null;
    const top = this.offY;
    const bottom = this.offY + this.view.height;
    for (const b of l.boxes) {
      if (b.top + b.height < top) continue;
      if (b.top > bottom) break;
      if (first === null) first = b.page;
      last = b.page;
    }
    return first === null ? null : [first, last];
  }

  /** The page read now: the first whose bottom is below a quarter of the view. */
  currentPage(l = this.layout()) {
    if (!l) return 1;
    const line = this.offY + this.view.height * 0.25;
    return (l.boxes.find((b) => b.top + b.height > line) ?? l.boxes[l.boxes.length - 1])?.page ?? 1;
  }

  // Moving.

  scrollBy(dx, dy, cx) {
    const l = this.layout();
    if (!l) return;
    const y = clamp(this.offY + dy, 0, this.maxY(l));
    const x = clamp(this.offX + dx, 0, this.maxX(l));
    if (y === this.offY && x === this.offX) return;
    this.offY = y;
    this.offX = x;
    cx.notify();
  }

  scrollToPage(page, cx, within = 0) {
    const l = this.layout();
    if (!l) {
      this.pendingPage = page;
      return;
    }
    const b = l.boxes[clamp(page, 1, l.boxes.length) - 1];
    if (!b) return;
    this.offY = clamp(b.top - PAD + within * b.height, 0, this.maxY(l));
    cx.notify();
  }

  /** A new zoom, keeping the page read now where it was. */
  setZoom(zoom, cx) {
    if (zoom === this.zoom) return;
    const before = this.layout();
    let anchor = null;
    if (before) {
      const page = this.currentPage(before);
      const b = before.boxes[page - 1];
      anchor = { page, frac: (this.offY - b.top) / b.height };
    }
    this.zoom = zoom;
    const after = this.layout();
    if (after && anchor) {
      const b = after.boxes[anchor.page - 1];
      this.offY = clamp(b.top + anchor.frac * b.height, 0, this.maxY(after));
      this.offX = clamp(this.offX, 0, this.maxX(after));
    }
    cx.notify();
  }

  /** The current scale in percent, for "fit" too. */
  percent(l = this.layout()) {
    if (this.zoom !== "fit") return this.zoom;
    const info = this.pdf.info;
    const w = info?.sizes?.[this.currentPage(l) - 1]?.[0] ?? LETTER[0];
    return l ? Math.round(((this.view.width - 2 * PAD) / w) * 100) : 100;
  }

  zoomStep(dir, cx) {
    const steps = PDF_ZOOMS.filter((z) => z !== "fit");
    const now = this.percent();
    const next = dir > 0 ? steps.find((z) => z > now) : [...steps].reverse().find((z) => z < now);
    if (next !== undefined) this.setZoom(next, cx);
  }

  jumpFromInput(cx) {
    const n = Number.parseInt(this.pageInput.value().trim(), 10);
    const pages = this.pdf.info?.pages ?? 0;
    this.editingPage = false;
    if (Number.isInteger(n) && n >= 1 && n <= pages) this.scrollToPage(n, cx);
    this.handle.focus();
    cx.notify();
  }

  editPage(cx) {
    this.editingPage = true;
    this.pageInput.set_value("");
    this.pageInput.focus();
    cx.notify();
  }

  // Asking the daemon (outside render).

  toggleOutline(cx) {
    this.outlineOpen = !this.outlineOpen;
    if (this.outlineOpen && !this.outline) this.loadOutline(cx);
    cx.notify();
  }

  loadOutline(cx) {
    this.outline = { busy: true };
    cx.spawn(async (cx) => {
      const r = await this.pdf.outline();
      this.outline = r?.error ? { error: r.error } : { items: Array.isArray(r?.items) ? r.items : [] };
      cx.notify();
    });
  }

  runSearch(dir, cx) {
    const q = this.searchInput.value().trim();
    const s = this.search;
    if (!q) {
      this.search = { query: "", hits: [], index: -1, busy: false, truncated: false, error: null };
      cx.notify();
      return;
    }
    if (q === s.query && s.hits.length && !s.busy) return this.moveHit(dir, cx);
    if (s.busy && q === s.query) return;
    this.search = { query: q, hits: [], index: -1, busy: true, truncated: false, error: null };
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await this.pdf.search(q);
      if (this.search.query !== q) return;
      const hits = Array.isArray(r?.hits) ? r.hits.filter((h) => Number.isInteger(h?.page)) : [];
      const from = this.currentPage();
      const first = hits.findIndex((h) => h.page >= from);
      this.search = { query: q, hits, index: hits.length ? Math.max(0, first) : -1, busy: false, truncated: r?.truncated === true, error: r?.error ?? null };
      if (hits.length) this.revealHit(cx);
      cx.notify();
    });
  }

  moveHit(dir, cx) {
    const s = this.search;
    if (!s.hits.length) return;
    s.index = (s.index + dir + s.hits.length) % s.hits.length;
    this.revealHit(cx);
    cx.notify();
  }

  /** Scrolls the current hit to a third of the way down the view. */
  revealHit(cx) {
    const hit = this.search.hits[this.search.index];
    const l = this.layout();
    if (!hit || !l) return;
    const b = l.boxes[hit.page - 1];
    if (!b) return;
    const rect = Array.isArray(hit.rects?.[0]) ? hit.rects[0] : [0, 0, 0, 0];
    this.offY = clamp(b.top + rect[1] * b.height - this.view.height / 3, 0, this.maxY(l));
    const x = this.left(l, b) + rect[0] * b.width;
    if (x < 0 || x > this.view.width - 40) this.offX = clamp(this.offX + x - this.view.width / 3, 0, this.maxX(l));
    cx.notify();
  }

  copyText(cx) {
    const page = this.currentPage();
    this.copy = { state: "busy", page };
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await this.pdf.text(page);
      if (r?.error) this.copy = { state: "failed", page };
      else if (!String(r?.text ?? "").trim()) this.copy = { state: "empty", page };
      else {
        cx.write_to_clipboard(r.text);
        this.copy = { state: "done", page };
      }
      this.copyTimer?.cancel();
      this.copyTimer = cx.timer.after(2500, (cx) => {
        this.copy = null;
        cx.notify();
      });
      cx.notify();
    });
  }

  fetchLinks(pages, cx) {
    for (const page of pages) {
      if (this.links.has(page) || this.linksPending.has(page)) continue;
      this.linksPending.add(page);
      cx.spawn(async (cx) => {
        const r = await this.pdf.links(page);
        this.linksPending.delete(page);
        this.links.set(page, Array.isArray(r?.links) ? r.links : []);
        cx.notify();
      });
    }
  }

  openPreview(cx) {
    cx.spawn(async () => {
      await openInPreview(this.file);
    });
  }

  followLink(link, cx) {
    if (link.kind === "page" && Number.isInteger(link.page)) this.scrollToPage(link.page, cx);
    else if (link.kind === "url" && /^https?:\/\//i.test(link.url ?? "")) cx.open_url(link.url);
  }

  /** Keys while the pages have the keyboard. True when handled. */
  key(e, cx) {
    const k = e.keystroke;
    const page = Math.max(LINE, this.view.height * 0.9);
    const l = this.layout();
    switch (k) {
      case "down":
        return this.scrollBy(0, LINE, cx), true;
      case "up":
        return this.scrollBy(0, -LINE, cx), true;
      case "right":
        return this.scrollBy(LINE, 0, cx), true;
      case "left":
        return this.scrollBy(-LINE, 0, cx), true;
      case "pagedown":
      case "space":
        return this.scrollBy(0, page, cx), true;
      case "pageup":
      case "shift-space":
        return this.scrollBy(0, -page, cx), true;
      case "home":
      case "cmd-up":
        return this.scrollBy(0, -this.offY, cx), true;
      case "end":
      case "cmd-down":
        return l ? (this.scrollBy(0, this.maxY(l) - this.offY, cx), true) : false;
      case "=":
      case "+":
      case "shift-=":
        return this.zoomStep(1, cx), true;
      case "-":
        return this.zoomStep(-1, cx), true;
      case "0":
        return this.setZoom("fit", cx), true;
      case "cmd-f":
        if (!this.full) return false;
        this.searchInput.focus();
        return true;
      default:
        return false;
    }
  }

  // Drawing.

  left(l, b) {
    return l.width <= this.view.width ? (this.view.width - b.width) / 2 : PAD + (l.widest - b.width) / 2 - this.offX;
  }

  /** A debug line written right after this render (debugLog writes a file: never in render). */
  logSoon(msg, cx) {
    cx.timer.after(0, () => debugLog("pdf-view", msg));
  }

  pageBox(l, b, k, cx) {
    const r = this.pdf.page(b.page);
    const err = r ? null : this.pdf.pageError(b.page);
    const x = this.left(l, b);
    const hits = this.search.hits;
    const cur = hits[this.search.index];
    let el = div()
      .absolute()
      .left(x)
      .top(b.top - this.offY)
      .w(b.width)
      .h(b.height)
      .bg(k.bg.raised)
      .border_1()
      .border_color(k.line.soft)
      .shadow_sm()
      .overflow_hidden()
      .accessibility_label(t("filetab.pdf.page-of", { page: b.page, pages: l.boxes.length }));
    if (r) {
      // Inside the 1 px border; image() needs a definite size.
      const w = Math.max(1, Math.round(b.width - 2));
      const h = Math.max(1, Math.round(b.height - 2));
      el = el.child(image(r.path).absolute().left(0).top(0).w(w).h(h));
      const shown = `${r.path} ${w}×${h}`;
      if (this.attached.get(b.page) !== shown) {
        this.attached.set(b.page, shown);
        if (this.attached.size > 64) this.attached.delete(this.attached.keys().next().value);
        this.logSoon(`page ${b.page} attached: ${shown}`, cx);
      }
    } else if (err) {
      el = el.child(
        v_flex()
          .absolute()
          .inset_0()
          .items_center()
          .justify_center()
          .gap(8)
          .child(Text(t("filetab.pdf.page-failed", { page: b.page }), { size: "sm", tone: "error" }))
          .child(Button(`pdf-page-retry-${b.page}`, t("common.retry"), { size: "sm", onClick: (_e, cx) => this.pdf.retry() })),
      );
    } else el = el.child(h_flex().absolute().inset_0().items_center().justify_center().child(Spinner({ size: 16 })));
    const rect = (rc, color, id) => {
      const [rx, ry, rw, rh] = rc;
      return div()
        .when(Boolean(id), (e) => e.id(id))
        .absolute()
        .left(rx * b.width)
        .top(ry * b.height)
        .w(Math.max(2, rw * b.width))
        .h(Math.max(2, rh * b.height))
        .when(Boolean(color), (e) => e.bg(color).rounded(2));
    };
    for (const hit of hits) {
      if (hit.page !== b.page) continue;
      const color = hit === cur ? withAlpha(k.accent2, 0.55) : withAlpha(k.accent, 0.28);
      for (const rc of Array.isArray(hit.rects) ? hit.rects : []) if (Array.isArray(rc) && rc.length === 4) el = el.child(rect(rc, color));
    }
    (this.links.get(b.page) ?? []).forEach((link, i) => {
      if (!Array.isArray(link?.rect) || link.rect.length !== 4) return;
      const tip = link.kind === "page" ? t("filetab.pdf.link-to-page", { page: link.page }) : t("filetab.pdf.link-open", { url: link.url ?? "" });
      el = el.child(
        rect(link.rect, null, `pdf-link-${b.page}-${i}`)
          .cursor_pointer()
          .rounded(2)
          .tooltip(tip)
          .hover((s) => s.bg(withAlpha(k.accent, 0.12)))
          .on_click((_e, cx) => this.followLink(link, cx)),
      );
    });
    return el;
  }

  scrollbar(l, k) {
    const max = this.maxY(l);
    if (max <= 0 || !this.view.height) return null;
    const track = this.view.height - 8;
    const thumb = Math.max(28, (track * this.view.height) / l.height);
    const top = 4 + ((track - thumb) * this.offY) / max;
    return div()
      .id("pdf-thumb")
      .absolute()
      .right(3)
      .top(top)
      .w(6)
      .h(thumb)
      .rounded(3)
      .bg(withAlpha(k.text.tertiary, this.drag ? 0.7 : 0.4))
      .hover((s) => s.bg(withAlpha(k.text.tertiary, 0.7)))
      .on_mouse_down("left", (e, cx) => {
        this.drag = { y: e.position.y, offY: this.offY, per: max / Math.max(1, track - thumb) };
        cx.stop_propagation();
        cx.notify();
      });
  }

  pages(l, k, cx) {
    const vis = l ? this.visible(l) : null;
    if (l && vis) {
      const shown = l.boxes.slice(vis[0] - 1, vis[1]);
      const widest = Math.max(...shown.map((b) => b.width));
      const width = Math.ceil((widest * DPR) / WIDTH_STEP) * WIDTH_STEP;
      this.pdf.want(vis[0], vis[1], width);
      const note = `pages ${vis[0]}–${vis[1]} of ${l.boxes.length} at ${width} px (view ${Math.round(this.view.width)}×${Math.round(this.view.height)}${this.view.guessed ? ", guessed" : ""})`;
      if (note !== this.lastNote) {
        this.lastNote = note;
        cx.timer.after(0, () => debugLog("pdf-view", note));
      }
      const missing = this.full ? shown.map((b) => b.page).filter((p) => !this.links.has(p) && !this.linksPending.has(p)) : [];
      if (missing.length && !this.linksTimer) {
        this.linksTimer = cx.timer.after(0, (cx) => {
          this.linksTimer = null;
          this.fetchLinks(missing, cx);
        });
      }
    }
    if (l && this.pendingPage !== null) {
      const page = this.pendingPage;
      this.pendingPage = null;
      const b = l.boxes[clamp(page, 1, l.boxes.length) - 1];
      if (b) this.offY = clamp(b.top - PAD, 0, this.maxY(l));
    }
    return div()
      .id("pdf-pages")
      .relative()
      .flex_1()
      .h_full()
      .min_w(0)
      .min_h(0)
      .overflow_hidden()
      .bg(k.bg.surface)
      .track_focus(this.handle)
      .on_size_change((size, cx) => {
        debugLog("pdf-view", `page area ${Math.round(size.width)}×${Math.round(size.height)}`);
        // A zero size (not laid out yet) keeps the guess, so pages are still asked for.
        if (size.width < 1 || size.height < 1) return;
        if (!this.view.guessed && Math.abs(size.width - this.view.width) < 1 && Math.abs(size.height - this.view.height) < 1) return;
        this.view = { width: size.width, height: size.height };
        const next = this.layout();
        if (next) {
          this.offY = clamp(this.offY, 0, this.maxY(next));
          this.offX = clamp(this.offX, 0, this.maxX(next));
        }
        cx.notify();
      })
      .on_scroll_wheel((e, cx) => {
        let dx = e.delta?.x ?? 0;
        let dy = e.delta?.y ?? 0;
        if (e.modifiers?.shift && !dx) [dx, dy] = [dy, 0];
        this.scrollBy(-dx, -dy, cx);
      })
      .on_mouse_down("left", (_e, cx) => {
        this.drag = null;
        this.handle.focus();
        cx.notify();
      })
      .on_mouse_move((e, cx) => {
        if (!this.drag) return;
        const l2 = this.layout();
        if (!l2) return;
        const y = clamp(this.drag.offY + (e.position.y - this.drag.y) * this.drag.per, 0, this.maxY(l2));
        if (y !== this.offY) {
          this.offY = y;
          cx.notify();
        }
      })
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
      .on_key_down((e, cx) => {
        if (this.handle.is_focused() && this.key(e, cx)) cx.stop_propagation();
      })
      .when(Boolean(l && vis), (e) => e.children(l.boxes.slice(vis[0] - 1, vis[1]).map((b) => this.pageBox(l, b, k, cx))))
      .when(Boolean(l), (e) => {
        const bar = this.scrollbar(l, k);
        return bar ? e.child(bar) : e;
      });
  }

  render(cx) {
    const k = tokens();
    if (this.pdf.state !== "ready" || !this.pdf.info) return pdfStatus(this, k);
    if (this.wantOutline) {
      this.wantOutline = false;
      cx.timer.after(0, (cx) => this.loadOutline(cx));
    }
    // Until the page area reports its size, a typical one: the visible pages are asked for at once.
    if (this.view.width < 1 || this.view.height < 1) this.view = { ...FALLBACK, guessed: true };
    const l = this.layout();
    return v_flex()
      .id("pdf-view")
      .size_full()
      .min_w(0)
      .min_h(0)
      .bg(k.bg.card)
      .child(pdfToolbar(this, l, k))
      .child(
        h_flex()
          .flex_1()
          .min_h(0)
          .min_w(0)
          .items_stretch()
          .when(this.outlineOpen && this.full, (e) => e.child(outlinePanel(this, l, k)))
          .child(this.pages(l, k, cx)),
      );
  }
}
