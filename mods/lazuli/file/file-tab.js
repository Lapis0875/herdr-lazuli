// A file opened as a center tab (`view: "file"`, props fid, file, on, preview, mode?, line?; DESIGN
// B1–B11): the native editor for Edit and Split, and the view each kind previews in: Markdown
// (md-view.js), an HTML tab's viewer pane through the model's viewer state or html-fallback.js, a PDF
// (pdf-view.js), a picture or SVG (image-view.js), or the info card (info-card.js). ⌘S saves (a key
// handler around the editor); ⌘⇧V reaches it as the `file-mode` command (sys/bus.js routes it by
// `this.tab`). FileModel (model.js) holds the state; this file draws it.
//
// One header row per file tab (mockup A): the tab publishes its header state (file/ui/head.js) and the
// lazuli layout's pane header draws it; elsewhere the tab draws the row itself. The banners (draft,
// conflict, failed save) are always the tab's own.
//
// `preview: true` in this view's props is the B2 preview tab, not a non-acting mount: the tab loads,
// watches and saves its file either way.

import { div } from "gpui-kit";
import { h_flex, v_flex, Editor, EditorState } from "gpui-base";
import { props as hostProps } from "herdr";
import { t } from "../core/i18n.js";
import { nextMode } from "../core/paths.js";
import { pin, resolveOwn } from "../sys/filetabs.js";
import { tokens } from "../ui/tokens.js";
import { Empty, Spinner, Text, ViewRoot } from "../ui/kit.js";
import { FileModel } from "./model.js";
import { MdView } from "./md-view.js";
import { HtmlFallback } from "./html-fallback.js";
import { ImageView } from "./image-view.js";
import { InfoCard } from "./info-card.js";
import { PdfView } from "./pdf-view.js";
import { VIEWER_GRACE_MS } from "./viewer.js";
import { fileBanners } from "./ui/header.js";
import { dropHead, fileHeader, headChanged, headStateOf, paneHeadDrawsFileHeads, publishHead, registerFileTab } from "./ui/head.js";
import { isProse, languageOf, syntaxFor } from "./ui/lang.js";

/** The editor's code size in px. */
const EDITOR_SIZE = 13;
/** After typing stops, the header is drawn again this late, so the draft note shows. */
const DRAFT_NOTE_MS = 1300;

const log = (msg) => console.log(`[lazuli/file-tab] ${msg}`);

export default class FileTab {
  constructor(name) {
    this.name = name;
    /** This copy's tab id once resolved (sys/bus.js routes `file-mode` by it). */
    this.tab = null;
  }

  init(p, cx) {
    const pr = p ?? hostProps() ?? {};
    this.props = pr;
    this.fid = typeof pr.fid === "string" ? pr.fid : "";
    this.handle = cx.focus_handle();
    this.editor = null;
    this.editorKey = "";
    this.editorSyntax = "";
    this.width = 0;
    this.jobs = new Map();
    this.draftNote = null;
    this.model = new FileModel({
      fid: this.fid,
      file: pr.file,
      on: pr.on,
      preview: pr.preview,
      mode: pr.mode,
      line: pr.line,
      onText: (text) => this.onText(text),
    });
    this.md = new MdView(this.model, () => this.handle.focus());
    this.html = new HtmlFallback(this.model);
    this.image = new ImageView(this.model, () => this.handle.focus());
    this.info = new InfoCard(this.model);
    this.pdf = null;
    this.model.start(cx);
    registerFileTab(this.fid, this);
  }

  // The editor.

  /** The text the editor must hold now (a load, reload or restored draft). Outside render. */
  onText(text) {
    const m = this.model;
    const lang = languageOf(m.name);
    const key = `${lang}|${m.readOnly ? 1 : 0}`;
    const syntax = JSON.stringify(tokens().editorSyntax);
    if (this.editor && this.editorKey === key && this.editorSyntax === syntax) {
      if (this.editor.value() !== text) this.editor.set_value(text);
    } else this.makeEditor(text);
    if (m.kind === "md") this.md.update(text);
  }

  makeEditor(text) {
    const m = this.model;
    const k = tokens();
    const lang = languageOf(m.name);
    this.editor?.release();
    this.editor = null;
    try {
      this.editor = EditorState.new({
        language: lang,
        value: text,
        readonly: m.readOnly,
        soft_wrap: isProse(lang),
        font_family: k.fonts.mono,
        font_size: EDITOR_SIZE,
        syntax: syntaxFor(lang, k),
      });
    } catch (e) {
      log(`editor not made: ${e?.message ?? e}`);
      return;
    }
    this.editorKey = `${lang}|${m.readOnly ? 1 : 0}`;
    this.editorSyntax = JSON.stringify(k.editorSyntax);
    this.editor.on("change", (_e, cx) => this.changed(cx));
  }

  /** The person typed: the model's buffer and dirty marker, the previews follow. */
  changed(cx) {
    const m = this.model;
    if (!this.editor) return;
    const text = this.editor.value();
    const was = m.dirty;
    m.edited(text, cx);
    if (m.kind === "md") this.md.follow(text, cx);
    if (was !== m.dirty) cx.notify();
    if (m.dirty) {
      this.draftNote?.cancel();
      this.draftNote = cx.timer.after(DRAFT_NOTE_MS, (cx) => {
        this.draftNote = null;
        cx.notify();
      });
    }
  }

  /** Puts the cursor at the start of a 1-based line and gives the editor the keyboard. */
  goToLine(line) {
    if (!this.editor) return;
    const text = this.editor.value();
    let at = 0;
    for (let n = 1; n < line; n++) {
      const next = text.indexOf("\n", at);
      if (next < 0) break;
      at = next + 1;
    }
    this.editor.set_selected_range({ start: at, end: at });
    this.editor.focus();
  }

  save(cx) {
    if (this.model.save(cx)) cx.notify();
  }

  // Modes.

  /** The mode the tab shows: an HTML tab's viewer pane decides, unless no browser exists (then the
   *  fallback preview follows the wanted mode). */
  shownMode(viewer) {
    const m = this.model;
    return viewer?.fallback ? m.mode : m.shownMode();
  }

  setMode(mode, cx) {
    // Renamed to a picture or PDF with unsaved text: Edit only until it opens as that kind.
    if (this.model.kindPending && mode !== "edit") return;
    this.model.setMode(mode);
    cx.notify();
  }

  /** ⌘⇧V: the next mode the kind offers. */
  cycle(cx) {
    const m = this.model;
    if (m.status !== "ready" || m.kindPending) return;
    const v = m.kind === "html" && !m.on ? m.viewer() : null;
    if (v?.fallback) {
      const next = nextMode(m.kind, m.mode, { remote: Boolean(m.on) });
      if (next) m.setMode(next);
    } else m.cycleMode();
    cx.notify();
  }

  toggleChrome(cx) {
    const m = this.model;
    if (m.chrome) m.closeChrome();
    else m.openChrome();
    cx.notify();
  }

  pinTab(cx) {
    pin(this.fid);
    this.publish();
    cx.notify();
  }

  /** The header as the tab shows it now (the mode an HTML viewer pane shows, the viewer's progress). */
  headState() {
    const m = this.model;
    const viewer = m.status === "ready" && !m.on && (m.kind === "html" || m.kind === "md") ? m.viewer() : null;
    return headStateOf(m, { mode: this.shownMode(viewer), viewer });
  }

  /** Publishes the header state for the pane header when it changed (outside render). */
  publish() {
    if (this.fid) publishHead(this.fid, this.headState());
  }

  // Host hooks: commands, keys, focus, close.

  command(command, cx) {
    if (command === "file-mode") this.cycle(cx);
  }

  /** Keys in the tab (and the `key:` test hook). True when handled. */
  key(e, cx) {
    const m = this.model;
    if (e.keystroke === "cmd-s") {
      if (!m.editable) return false;
      this.save(cx);
      return true;
    }
    if ((m.kind === "image" || (m.kind === "svg" && m.mode === "preview")) && m.status === "ready") return this.image.key(e, cx);
    // The preview's scroll keys, when the tab itself (not the editor) has the keyboard.
    if (m.kind === "md" && m.status === "ready" && m.mode !== "edit" && this.handle.is_focused()) return this.md.key(e, cx);
    return false;
  }

  /** Herdr gave this copy the keyboard: the editor when it shows, else the PDF's pages, else the tab. */
  focus(cx) {
    const m = this.model;
    if (this.editor && m.status === "ready" && m.modes.includes("edit") && m.mode !== "preview" && m.kind !== "pdf") this.editor.focus();
    else if (this.pdf && m.kind === "pdf") this.pdf.handle.focus();
    else this.handle.focus();
    cx.notify();
  }

  async close(_cx) {
    for (const job of this.jobs.values()) job.cancel();
    this.jobs.clear();
    this.draftNote?.cancel();
    this.md.release();
    this.pdf?.dispose();
    this.pdf = null;
    dropHead(this.fid);
    await this.model.close();
    this.editor?.release();
    this.editor = null;
    this.handle.release?.();
  }

  // Work render() asks for, run right after it (host state is made outside render).

  soon(name, cx, fn) {
    if (this.jobs.has(name)) return;
    this.jobs.set(
      name,
      cx.timer.after(0, (cx) => {
        this.jobs.delete(name);
        try {
          fn(cx);
        } catch (e) {
          log(`${name}: ${e?.message ?? e}`);
        }
        cx.notify();
      }),
    );
  }

  upkeep(cx, k) {
    const m = this.model;
    const ready = m.status === "ready";
    if (m.kind === "pdf" && ready && !m.on && this.pdf?.file !== m.file) {
      this.soon("pdf", cx, (cx) => {
        this.pdf?.dispose();
        this.pdf = m.kind === "pdf" ? new PdfView(m.file, cx) : null;
        this.pdfRevision = m.revision;
      });
    } else if (this.pdf && (m.kind !== "pdf" || this.pdf.file !== m.file || m.status === "missing")) {
      // A PDF gone from disk shows the missing state, not its old pages; it opens afresh if it returns.
      this.soon("pdf-drop", cx, () => {
        this.pdf?.dispose();
        this.pdf = null;
      });
    } else if (this.pdf && m.kind === "pdf" && this.pdf.file === m.file && this.pdfRevision !== m.revision) {
      // Replaced on disk (model.revision rose): the client opens it again.
      this.pdfRevision = m.revision;
      this.soon("pdf-reload", cx, () => this.pdf?.pdf.reload());
    }
    if ((m.kind === "image" || m.kind === "svg") && ready && this.image.needsMeasure()) this.soon("measure", cx, (cx) => this.image.measure(cx));
    if (this.editor && this.editorSyntax !== JSON.stringify(k.editorSyntax)) {
      this.soon("theme", cx, () => this.makeEditor(this.editor ? this.editor.value() : m.buffer));
    }
    if (this.md.stale(k)) this.soon("md-theme", cx, () => this.md.prepare());
    if (m.kind === "md" && m.mode !== "edit" && this.md.parsing) this.soon("md-parse", cx, () => this.md.step());
    if (ready && m.line && this.editor) {
      this.soon("line", cx, () => {
        const line = m.takeLine();
        if (line) this.goToLine(line);
      });
    }
  }

  /** The viewer pane went away after it was shown (its × in the pane header, or the viewer quit):
   *  the tab stops wanting it — Markdown's "View in Chrome" goes off, an HTML tab goes to Edit — so no
   *  "opening" spinner, saved-file note or lit button stays behind. A pane the model closes or
   *  replaces itself (Edit, a reload, a retarget, a rename that splits again on the new path) is not
   *  this: the model keeps the viewer pending (`viewerPending`) until its own steps have landed. */
  watchViewer(v, cx) {
    const m = this.model;
    if (m.viewerPending) return;
    if (!v || v.fallback || v.have === "unknown" || v.want === "none") {
      if (!v || v.want === "none") this.viewerSeen = false;
      return;
    }
    if (v.have !== "none") {
      this.viewerSeen = true;
      return;
    }
    // The grace counts from the later of the last split and the last change the model began (a slow
    // re-split after a rename lands well after the change).
    if (!this.viewerSeen || Date.now() - Math.max(m.splitAt, m.viewerSince ?? 0) < VIEWER_GRACE_MS) return;
    this.viewerSeen = false;
    this.soon("viewer-closed", cx, () => {
      // Looked at again when it runs: the model may have started its own steps meanwhile.
      const now = m.viewer();
      if (m.viewerPending || now.have !== "none" || now.want === "none") return;
      if (m.kind === "md") m.closeChrome();
      else if (m.kind === "html") m.setMode("edit");
      this.publish();
    });
  }

  // Drawing.

  render(cx) {
    const m = this.model;
    m.follow();
    const ids = resolveOwn(this.fid, { file: this.props.file, on: this.props.on, preview: this.props.preview });
    if (ids) this.tab = ids.tab;
    const k = tokens();
    this.upkeep(cx, k);
    const viewer = m.status === "ready" && !m.on && (m.kind === "html" || m.kind === "md") ? m.viewer() : null;
    this.watchViewer(viewer, cx);
    const mode = this.shownMode(viewer);
    const head = headStateOf(m, { mode, viewer });
    if (headChanged(this.fid, head)) this.soon("publish", cx, () => this.publish());
    return ViewRoot("file-tab")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (this.key(e, cx)) cx.stop_propagation();
      })
      .on_size_change((size, cx) => {
        if (Math.abs(size.width - this.width) < 1) return;
        this.width = size.width;
        cx.notify();
      })
      .when(!paneHeadDrawsFileHeads(), (e) =>
        e.child(
          fileHeader(head, {
            width: this.width,
            onMode: (key, cx) => this.setMode(key, cx),
            onPin: (cx) => this.pinTab(cx),
            onChrome: (cx) => this.toggleChrome(cx),
          }),
        ),
      )
      .children(fileBanners(m))
      .child(div().flex_1().min_h(0).min_w(0).flex().child(this.body(cx, k, mode, viewer)));
  }

  editorPane(k) {
    if (!this.editor) return this.waiting(k, t("filetab.status.loading"));
    return v_flex()
      .id("file-editor")
      .size_full()
      .min_w(0)
      .min_h(0)
      .pt(6)
      .bg(k.bg.card)
      .accessibility_label(t("filetab.editor"))
      .child(Editor.new(this.editor).flex_1().min_h(0).min_w(0));
  }

  split(left, right, k) {
    return h_flex()
      .size_full()
      .min_h(0)
      .min_w(0)
      .child(div().flex_1().min_w(0).h_full().border_r(1).border_color(k.line.soft).child(left))
      .child(div().flex_1().min_w(0).h_full().child(right));
  }

  waiting(k, label) {
    return v_flex()
      .size_full()
      .items_center()
      .justify_center()
      .gap(10)
      .bg(k.bg.card)
      .role("status")
      .child(Spinner({ size: 18 }))
      .child(Text(label, { size: "sm", tone: "secondary" }));
  }

  body(cx, k, mode, viewer) {
    const m = this.model;
    switch (m.status) {
      case "loading":
        return this.waiting(k, t("filetab.status.loading"));
      case "missing":
        return v_flex().size_full().justify_center().child(Empty({ id: "file-missing", icon: "file", title: t("filetab.status.missing"), body: m.file }));
      case "error":
        return v_flex()
          .size_full()
          .justify_center()
          .child(Empty({ id: "file-error", icon: "triangle-alert", title: t("filetab.status.error", { detail: m.error ?? "" }), body: m.file }));
      case "binary":
        return this.info.render(cx, { title: t("filetab.status.binary"), icon: "file" });
      case "info":
        return this.info.render(cx, { title: t("filetab.status.info"), icon: m.kind === "image" ? "image" : "file" });
      default:
        break;
    }
    if (m.kindPending) return this.editorPane(k);
    switch (m.kind) {
      case "pdf":
        return this.pdf && this.pdf.file === m.file ? this.pdf.render(cx) : this.waiting(k, t("filetab.pdf.opening"));
      case "image":
        return this.image.render(cx);
      case "md":
        if (mode === "preview") return this.md.render(cx);
        return mode === "split" ? this.split(this.editorPane(k), this.md.render(cx), k) : this.editorPane(k);
      case "svg":
        if (mode === "preview") return this.image.render(cx);
        return mode === "split" ? this.split(this.editorPane(k), this.image.render(cx), k) : this.editorPane(k);
      case "html":
        // With a browser the page shows in the viewer pane beside (Split) or over (Preview) this one.
        if (!viewer?.fallback) return this.editorPane(k);
        if (mode === "preview") return this.html.render(cx);
        return mode === "split" ? this.split(this.editorPane(k), this.html.render(cx), k) : this.editorPane(k);
      default:
        return this.editorPane(k);
    }
  }
}
