// A picture in a file tab (DESIGN B3): PNG, JPEG, GIF and WebP files, and an SVG's preview (its buffer
// rendered into the picture cache by the model). Fit, or fixed zoom steps (+ / - / 0, the buttons, a
// pinch); larger than the pane, it scrolls both ways. The natural size comes from `sips` (else
// `file`) for raster files and from the width/height/viewBox of an SVG's text; until it is known the
// picture fills the area, scaled to fit.

import { div, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { appHome, exec } from "herdr";
import { t } from "../core/i18n.js";
import { debugLog } from "../sys/store.js";
import { tokens } from "../ui/tokens.js";
import { Button, Empty, IconButton, Spacer, Spinner, Text } from "../ui/kit.js";

/** The picture area's size until its first layout reports one (logical px). */
const FALLBACK = Object.freeze({ width: 900, height: 600 });
const PAD = 16;

/** Zoom steps after "fit", in percent. */
export const IMAGE_ZOOMS = Object.freeze([25, 50, 75, 100, 150, 200, 300, 400]);
const MIN_SCALE = 0.05;
const MAX_SCALE = 8;

const num = (v) => {
  const n = Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) && n > 0 ? n : null;
};

/** `{width, height}` an SVG's text declares (its width/height, else its viewBox), or null. */
export function svgSize(text) {
  const head = String(text ?? "").match(/<svg\b[^>]*>/i)?.[0];
  if (!head) return null;
  const attr = (name) => head.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1] ?? null;
  const w = attr("width");
  const h = attr("height");
  if (w && h && !/%/.test(w + h) && num(w) && num(h)) return { width: num(w), height: num(h) };
  const box = (attr("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  if (box.length === 4 && box[2] > 0 && box[3] > 0) return { width: box[2], height: box[3] };
  return null;
}

export class ImageView {
  /** `model`: the tab's FileModel; `takeKeys()`: gives the tab the keyboard (for the zoom keys). */
  constructor(model, takeKeys) {
    this.model = model;
    this.takeKeys = typeof takeKeys === "function" ? takeKeys : null;
    this.zoom = "fit";
    this.dims = null;
    this.dimsFor = null;
    this.measuring = false;
    this.area = { width: 0, height: 0 };
  }

  /** Whether the shown picture's natural size is still to be read. Safe in render. */
  needsMeasure() {
    const m = this.model;
    if (!m.imagePath || this.measuring) return false;
    const key = m.kind === "svg" ? `svg:${m.buffer.length}:${m.imagePath}` : m.imagePath;
    return key !== this.dimsFor;
  }

  /** Reads the natural size (outside render). */
  measure(cx) {
    const m = this.model;
    if (!m.imagePath) return;
    if (m.kind === "svg") {
      this.dimsFor = `svg:${m.buffer.length}:${m.imagePath}`;
      this.dims = svgSize(m.buffer);
      return;
    }
    const path = m.imagePath;
    const abs = `${appHome()}/${path}`;
    this.measuring = true;
    cx.spawn(async (cx) => {
      let dims = null;
      let how = "none";
      try {
        const r = await exec("sips", ["-g", "pixelWidth", "-g", "pixelHeight", abs], { timeout: 10000 });
        const w = num(r.stdout.match(/pixelWidth:\s*(\d+)/)?.[1]);
        const h = num(r.stdout.match(/pixelHeight:\s*(\d+)/)?.[1]);
        if (w && h) [dims, how] = [{ width: w, height: h }, "sips"];
      } catch (e) {
        how = `sips failed: ${e?.message ?? e}`;
      }
      if (!dims) {
        try {
          // "PNG image data, 1440 x 900, …", "JPEG image data, …, 1440x900, …", "Web/P image, …, 1440x900".
          const r = await exec("file", ["-b", abs], { timeout: 10000 });
          const hit = r.stdout.match(/(\d{1,6})\s*x\s*(\d{1,6})/);
          if (hit && num(hit[1]) && num(hit[2])) [dims, how] = [{ width: num(hit[1]), height: num(hit[2]) }, "file"];
        } catch (e) {
          how = `${how}; file failed: ${e?.message ?? e}`;
        }
      }
      debugLog("image-view", `${path}: ${dims ? `${dims.width}×${dims.height}` : "size unknown"} (${how})`);
      this.measuring = false;
      this.dimsFor = path;
      this.dims = dims;
      cx.notify();
    });
  }

  /** The area the picture is shown in: the measured one, else a typical one. */
  box() {
    return this.area.width >= 1 && this.area.height >= 1 ? this.area : FALLBACK;
  }

  /** The scale "fit" means in the shown area: contain; raster pictures are not enlarged. */
  fitScale() {
    const d = this.dims;
    if (!d) return 1;
    const a = this.box();
    const s = Math.min((a.width - 2 * PAD) / d.width, (a.height - 2 * PAD) / d.height);
    const capped = this.model.kind === "svg" ? Math.min(MAX_SCALE, s) : Math.min(1, s);
    return Math.max(MIN_SCALE, capped);
  }

  scale() {
    return this.zoom === "fit" ? this.fitScale() : this.zoom / 100;
  }

  step(dir, cx) {
    const now = Math.round(this.scale() * 100);
    const next = dir > 0 ? IMAGE_ZOOMS.find((z) => z > now + 0.5) : [...IMAGE_ZOOMS].reverse().find((z) => z < now - 0.5);
    if (next !== undefined) this.zoom = next;
    cx.notify();
  }

  setZoom(zoom, cx) {
    this.zoom = zoom;
    cx.notify();
  }

  /** + / - / 0 while the picture has the keyboard (⌘ with them is the app's zoom). True when handled. */
  key(e, cx) {
    if (!this.dims) return false;
    const k = e.keystroke;
    if (k === "=" || k === "+" || k === "shift-=") return this.step(1, cx), true;
    if (k === "-") return this.step(-1, cx), true;
    if (k === "0") return this.setZoom("fit", cx), true;
    return false;
  }

  pinch(e, cx) {
    if (!this.dims) return;
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale() * (1 + e.delta)));
    this.zoom = Math.round(next * 100);
    cx.notify();
  }

  toolbar(k) {
    const d = this.dims;
    const pct = Math.round(this.scale() * 100);
    const label = this.zoom === "fit" ? t("filetab.zoom.fit") : `${pct}%`;
    const kind = this.model.kind === "svg" ? "SVG" : (this.model.name.split(".").pop() ?? "").toUpperCase();
    return h_flex()
      .flex_none()
      .h(34)
      .px(10)
      .gap(4)
      .items_center()
      .border_b(1)
      .border_color(k.line.soft)
      .child(Text(d ? `${d.width} × ${d.height} · ${kind}` : kind, { size: "xs", tone: "tertiary", mono: true, nowrap: true }))
      .child(Spacer())
      .child(IconButton("img-zoom-out", "zoom-out", t("filetab.zoom.out"), { size: "md", disabled: !d, onClick: (_e, cx) => this.step(-1, cx) }))
      .child(
        Button("img-zoom-fit", label, {
          variant: "ghost",
          size: "sm",
          disabled: !d,
          tooltip: t(this.zoom === "fit" ? "filetab.zoom.actual" : "filetab.zoom.fit"),
          a11y: t("filetab.zoom.label"),
          onClick: (_e, cx) => this.setZoom(this.zoom === "fit" ? 100 : "fit", cx),
        }).min_w(64).justify_center(),
      )
      .child(IconButton("img-zoom-in", "zoom-in", t("filetab.zoom.in"), { size: "md", disabled: !d, onClick: (_e, cx) => this.step(1, cx) }));
  }

  render(_cx) {
    const k = tokens();
    const m = this.model;
    const root = v_flex().id("img-view").size_full().min_w(0).min_h(0).bg(k.bg.card);
    if (m.imageError) {
      return root.justify_center().child(Empty({ id: "img-error", icon: "image", title: t(`filetab.image.${m.imageError}`) }));
    }
    if (!m.imagePath) {
      return root.items_center().justify_center().child(Spinner({ size: 18, label: t("filetab.image.loading") }));
    }
    const d = this.dims;
    const s = this.scale();
    const a = this.box();
    // Without a natural size the picture fills the area and keeps its shape (image() fits by contain).
    const pw = Math.max(1, Math.round(d ? d.width * s : a.width - 2 * PAD));
    const ph = Math.max(1, Math.round(d ? d.height * s : a.height - 2 * PAD));
    const area = div()
      .id("img-area")
      .flex_1()
      .w_full()
      .min_h(0)
      .min_w(0)
      .bg(k.bg.surface)
      .overflow_scroll()
      .on_size_change((size, cx) => {
        debugLog("image-view", `area ${Math.round(size.width)}×${Math.round(size.height)} for ${m.imagePath}`);
        if (size.width < 1 || size.height < 1) return;
        if (Math.abs(size.width - this.area.width) < 1 && Math.abs(size.height - this.area.height) < 1) return;
        this.area = { width: size.width, height: size.height };
        cx.notify();
      })
      .on_pinch((e, cx) => this.pinch(e, cx))
      .on_mouse_down("left", () => {
        if (m.kind === "image" || m.mode === "preview") this.takeKeys?.();
      })
      .child(
        h_flex()
          .min_w(a.width)
          .min_h(a.height)
          .p(PAD)
          .items_center()
          .justify_center()
          .accessibility_label(m.name)
          .child(image(m.imagePath).flex_none().w(pw).h(ph)),
      );
    return root.child(this.toolbar(k)).child(area);
  }
}
