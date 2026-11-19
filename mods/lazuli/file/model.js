// The state machine behind a file tab (DESIGN B3–B5, B7, B10; ARCHITECTURE §6), without elements:
// load with the read-only rules, save with the Reload / Overwrite conflict, reload by itself while
// clean, drafts while dirty, the mode, and the pictures and viewer pane the tab shows.
//
// Use from file/file-tab.js:
//   init:   this.model = new FileModel({fid, file, on, preview, mode, line, onText}); this.model.start(cx)
//           onText(text) gets the text the editor must hold now (after a load, reload or restore):
//           create or set the EditorState there, never in render.
//   render: this.model.follow() first (a preview retarget, line requests), then read fields: status,
//           kind, modes, mode, shownMode(), buffer, readOnly, reason, truncated, dirty, saving,
//           conflict, failed, draft, info, imagePath, imageError, image(src), viewer().
//   events: edited(text, cx) on each editor change; save, reload, overwrite, restoreDraft,
//           discardDraft (cx); cycleMode(), setMode(mode); openChrome(), closeChrome(); takeLine();
//           openExternal().
//   close:  await this.model.close().
// Fields hold codes; the view maps them to catalog keys (filetab.*).

import * as fs from "fs/promises";
import { checking, exec, readTextFile, spaces, watchFolder, writeTextFile, run } from "herdr";
import { asidePathOf, copyStarted, draftDir, draftPathOf, entryOf, followRenames, forget, listDrafts, moveDrafts, rekeyDraft, removeDraft, renameSeq, resolveOwn, setDirty, setMode as saveMode, sha1, takeLine, tickName, writeAtomic } from "../sys/filetabs.js";
import { MAX_EDIT, basename, defaultMode, dirname, editability, kindOf, modesFor, nextMode, normalize } from "../core/paths.js";
import { DRAFT_EVERY_MS, decide, makeDraft, shouldWrite } from "../core/drafts.js";
import { resolveLink } from "../core/md-tree.js";
import { cacheImage, cacheText, fetchImage, forgetSource, lookupImage } from "./image-cache.js";
import { fileRevision } from "./pdf-client.js";
import { browserAvailable, viewerState } from "./viewer.js";

const log = (msg) => console.log(`[lazuli/file] ${msg}`);
const errText = (e) => e?.message ?? String(e);
/** Herdr's own words for a failure, without the call it came from. */
const said = (e) => String(e?.message ?? e).replace(/^`herdr\.\w+`:\s*/, "");

/** A shown tab reads its file again this often (also the remote poll, B10). */
export const CHECK_MS = 10000;
/** An SVG preview follows the buffer this long after the last edit. */
const SVG_DEBOUNCE_MS = 250;
/** The viewer is brought to the wanted state for at most this long after a change. */
const VIEWER_WAIT_MS = 10000;
/** A pane change seen this soon after our own viewer step may still be that step landing. */
const VIEWER_SETTLE_MS = 1500;
const TEXT_KINDS = new Set(["md", "html", "svg", "text"]);

/** Names for a copy beside `file`: `<name> (lazuli YYYY-MM-DD HH.MM).<ext>`, then ` 2`, ` 3`, … (local
 *  time of `at`). A dot file or a name without an extension gets the stamp at its end. */
function* copyNames(file, at) {
  const pad = (n) => String(n).padStart(2, "0");
  const stamp = `lazuli ${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}.${pad(at.getMinutes())}`;
  const dir = dirname(file);
  const name = basename(file);
  const dot = name.lastIndexOf(".");
  const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let n = 1; n <= 99; n++) yield `${dir === "/" ? "" : dir}/${stem} (${stamp}${n > 1 ? ` ${n}` : ""})${ext}`;
}

/** `<app home>/data/lazuli/drafts`. */
export { draftDir };

export class FileModel {
  constructor(o) {
    const e = entryOf(o?.fid);
    this.fid = String(o?.fid ?? "");
    this.file = normalize(e?.file ?? o?.file ?? "");
    this.on = (e ? e.on : o?.on) || null;
    this.preview = e ? e.preview === true : o?.preview === true;
    this.wantMode = typeof o?.mode === "string" ? o.mode : null;
    this.line = Number.isInteger(o?.line) && o.line > 0 ? o.line : null;
    this.onText = typeof o?.onText === "function" ? o.onText : null;
    /** "loading" | "ready" | "missing" | "binary" | "info" (a remote PDF or picture) | "error". */
    this.status = "loading";
    this.error = null;
    this.text = "";
    this.version = 0;
    this.buffer = "";
    this.writable = true;
    this.saving = false;
    this.chrome = false;
    this.browser = null;
    this.closed = false;
    this.started = false;
    this.needs = new Set();
    this.wake = null;
    this.queue = Promise.resolve();
    this.shown = false;
    this.watching = false;
    this.watch = null;
    this.lastCheck = 0;
    this.draftBusy = false;
    this.lastDraftAt = 0;
    this.svgTimer = null;
    this.wantImages = new Set();
    this.viewerPending = false;
    this.viewerSeen = null;
    this.viewerStepAt = 0;
    this.viewerSince = 0;
    this.viewerFile = null;
    this.renameSeq = renameSeq();
    this.draftQueue = Promise.resolve();
    copyStarted(this.fid);
    this.splitAt = 0;
    this.dirty = false;
    this.kindPending = false;
    /** Goes up when a PDF on disk is replaced: the tab opens it again (its PdfClient reload()). */
    this.revision = 0;
    this.pdfStamp = null;
    /** "not-replaced" while the last draft write could not replace the draft (a complete copy was
     *  kept beside it), else null. */
    this.draftError = null;
    this.reset();
  }

  get name() {
    return basename(this.file);
  }

  /** Text that can be edited and saved here. */
  get editable() {
    return this.status === "ready" && TEXT_KINDS.has(this.kind) && !this.readOnly;
  }

  /** The file's kind, modes and mode afresh; everything read from it forgotten. */
  reset() {
    this.kind = kindOf(this.file);
    this.modes = modesFor(this.kind, { remote: Boolean(this.on) });
    const want = entryOf(this.fid)?.mode ?? this.wantMode;
    this.mode = this.modes.includes(want) ? want : defaultMode(this.kind, { remote: Boolean(this.on) });
    for (const k of ["info", "conflict", "failed", "draft", "draftFrom", "copiedTo", "imagePath", "imageError", "disk", "diskHash", "lastDraftText"]) this[k] = null;
    this.original = "";
    this.readOnly = true;
    this.reason = null;
    this.truncated = false;
    this.draftOnDisk = false;
    this.kindPending = false;
    this.markDirty(false);
  }

  markDirty(dirty) {
    if (dirty === this.dirty) return;
    this.dirty = dirty;
    setDirty(this.fid, dirty);
    // Renamed to a non-text name while unsaved: once nothing is unsaved, its draft (now the disk's
    // text) goes and the file loads as its new kind.
    if (!dirty && this.kindPending) {
      this.kindPending = false;
      if (this.draftOnDisk) {
        const path = this.draftPath();
        this.draftOnDisk = false;
        this.queueDraft(() => removeDraft(path));
      }
      this.kick("load");
    }
  }

  /** Starts the load, the work loop and the 1 s tick (drafts, watch while shown, 10 s check, viewer). */
  start(cx) {
    if (this.started || checking()) return;
    this.started = true;
    cx.spawn(async (cx) => {
      while (!this.closed) {
        if (!this.needs.size) await new Promise((resolve) => (this.wake = resolve));
        if (this.closed) return;
        const needs = this.needs;
        this.needs = new Set();
        try {
          await this.serial(() => this.work(needs));
        } catch (e) {
          log(`${this.file}: ${errText(e)}`);
        }
        if (!this.closed) cx.notify();
      }
    });
    cx.timer.every(DRAFT_EVERY_MS, (cx) => this.tick(cx));
    this.kick("load");
  }

  kick(what) {
    this.needs.add(what);
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }

  serial(fn) {
    const job = this.queue.catch(() => {}).then(fn);
    this.queue = job.catch(() => {});
    return job;
  }

  async work(needs) {
    if (needs.has("load")) await this.load();
    else if (needs.has("disk")) await this.checkDisk();
    if (needs.has("svg") && this.kind === "svg" && this.status === "ready") await this.renderSvg(this.buffer);
    if (needs.has("images")) {
      const want = [...this.wantImages];
      this.wantImages.clear();
      for (const path of want) await fetchImage(path);
    }
  }

  /** First in render: the registry's file (a rename keeps the buffer, a preview retarget loads the new
   *  file); line requests are kept. */
  follow() {
    this.track();
    const line = takeLine(this.fid);
    if (line) this.line = line;
  }

  /** Follows the registry's file. Also on every tick, so a hidden tab follows a rename at once. */
  track() {
    const e = entryOf(this.fid);
    if (!e) return;
    this.preview = e.preview === true;
    const on = e.on || null;
    if (e.file === this.file && on === this.on) {
      this.renameSeq = renameSeq();
      return;
    }
    const r = followRenames(this.file, this.on, this.renameSeq);
    this.renameSeq = r.seq;
    if (on === this.on && r.path === e.file) return this.moveTo(e.file);
    this.file = e.file;
    this.on = on;
    this.status = "loading";
    this.chrome = false;
    this.watchStop();
    this.shown = false;
    // A viewer of the old file goes on the next tick (never from render); the load splits one again
    // when the new file wants it.
    this.markViewer();
    this.kick("load");
  }

  /** The file was renamed (or its folder): same text, new path. The buffer, unsaved edits, conflict
   *  and draft stay; the kind (and so the modes) follows the new name, the watch its folder, an HTML
   *  viewer is split again on the new path. Unsaved text renamed to a non-text name (a picture, a
   *  PDF) stays text, in Edit, with `kindPending` set, until it is saved or its edits are gone; then
   *  the file loads as its new kind. A non-text kind before, or nothing unsaved, loads afresh. */
  moveTo(file) {
    const from = this.file;
    const kind = kindOf(file);
    const remote = Boolean(this.on);
    const dirty = this.status === "ready" && this.dirty;
    // An offered draft of a closed tab moves with the file too (moveDrafts keeps its owner).
    if (this.draftFrom) this.draftFrom = rekeyDraft(this.draftFrom, file, this.on);
    this.file = file;
    this.watchStop();
    this.shown = false;
    // Drafts follow the name: one still being written lands on the old name, so they move once it is
    // done; unsaved edits are then written under the new name at once, not on the next tick.
    this.queueDraft(async () => {
      await moveDrafts(from, file, { on: this.on });
      if (this.dirty && this.file === file && !this.closed) await this.writeDraft(Date.now());
    });
    if (dirty && TEXT_KINDS.has(this.kind) && !TEXT_KINDS.has(kind)) {
      this.kindPending = true;
      this.chrome = false;
      if (this.modes.includes("edit")) this.mode = "edit";
      this.markViewer();
      this.kick("disk");
      return;
    }
    if (this.status !== "ready" || !TEXT_KINDS.has(this.kind) || !TEXT_KINDS.has(kind)) {
      this.status = "loading";
      this.chrome = false;
      this.markViewer();
      this.kick("load");
      return;
    }
    const viewed = this.kind === "html" || this.kind === "md";
    this.kind = kind;
    this.modes = modesFor(kind, { remote });
    const want = entryOf(this.fid)?.mode ?? this.wantMode;
    this.mode = this.modes.includes(want) ? want : defaultMode(kind, { remote });
    if (kind !== "md") this.chrome = false;
    // The next draft goes under the new name.
    if (this.dirty) this.lastDraftText = null;
    if (kind === "svg" && !remote) this.kick("svg");
    if (!remote && (viewed || kind === "html" || kind === "md")) {
      this.markViewer();
      browserAvailable().then((b) => {
        if (this.closed || this.file !== file) return;
        this.browser = b;
        this.wantViewer();
      });
    }
    this.kick("disk");
  }

  /** The line to show once the file is shown, or null. */
  takeLine() {
    if (this.status !== "ready") return null;
    const line = this.line;
    this.line = null;
    return line;
  }

  async load() {
    const { file, on } = this;
    this.status = "loading";
    this.error = null;
    this.reset();
    this.lastCheck = Date.now();
    if (!this.modes.length) {
      this.info = await this.describe();
      this.status = "info";
      return;
    }
    if (this.kind === "pdf" || this.kind === "image") {
      if (this.kind === "image") await this.pictureOf(file);
      else this.pdfStamp = await fileRevision(file);
      if (this.file === file) this.status = "ready";
      return;
    }
    let text;
    let writable = false;
    let tooLarge = false;
    try {
      [text, writable] = await Promise.all([readTextFile(file, { on }), on ? false : exec("test", ["-w", file]).then((r) => r.code === 0, () => true)]);
    } catch (e) {
      // Not valid UTF-8 → binary (text stays undefined); over 1 MiB → its head, read-only.
      const why = said(e);
      if (/exceeds 1 MiB/i.test(why)) {
        text = await this.readHead();
        tooLarge = true;
      }
      if (this.file !== file) return;
      if ((tooLarge && text === null) || (!tooLarge && !/valid UTF-8/i.test(why))) {
        this.status = "error";
        this.error = why;
        return;
      }
    }
    if (this.file !== file || this.on !== on) return;
    if (text === undefined || (tooLarge && text.slice(0, 8000).includes("\0"))) {
      this.modes = [];
      this.mode = null;
      this.info = await this.describe();
      this.status = "binary";
      return;
    }
    if (text === null) {
      this.status = "missing";
      // Gone from disk, but its unsaved edits may live on in a draft: offered as on any open (B5).
      // Restoring makes a buffer whose save creates the file again (writeTextFile expecting none).
      if (!on && TEXT_KINDS.has(this.kind)) {
        const writable = await exec("test", ["-w", dirname(file)]).then((r) => r.code === 0, () => false);
        if (this.file !== file) return;
        this.writable = writable;
        await this.queueDraft(() => this.findDraft(null));
      }
      return;
    }
    this.writable = writable;
    this.fill(text, tooLarge);
    this.status = "ready";
    if (this.editable) await this.queueDraft(() => this.findDraft(text));
    if (this.kind === "svg" && !on) await this.renderSvg(text);
    if (!on && (this.kind === "html" || this.kind === "md")) {
      this.browser = await browserAvailable();
      this.wantViewer();
    }
  }

  /** The disk text becomes the buffer (the editor gets it through onText). */
  fill(text, tooLarge = false) {
    if (tooLarge) {
      this.readOnly = true;
      this.reason = this.on ? "remote" : "too-large";
      this.truncated = true;
      this.original = text.length > MAX_EDIT ? text.slice(0, MAX_EDIT) : text;
    } else {
      const ed = editability({ text, writable: this.writable, on: this.on });
      this.readOnly = ed.readOnly;
      this.reason = ed.reason;
      this.truncated = text.length > MAX_EDIT;
      this.original = ed.text;
    }
    this.disk = text;
    this.diskHash = sha1(text);
    this.conflict = null;
    this.failed = null;
    this.replace(this.original);
    this.markDirty(false);
  }

  replace(text) {
    this.buffer = text;
    this.text = text;
    this.version += 1;
    try {
      this.onText?.(text);
    } catch (e) {
      log(`onText failed: ${errText(e)}`);
    }
  }

  async readHead() {
    try {
      const r = await exec("head", ["-c", String(MAX_EDIT * 4), this.file], { on: this.on, timeout: 20000 });
      return r.code === 0 ? r.stdout : null;
    } catch {
      return null;
    }
  }

  /** `{size, type}` for the info card (B3: binary, a remote PDF or picture). */
  async describe() {
    try {
      const r = await exec("sh", ["-c", 'wc -c < "$1" | tr -d " "; file -b "$1" 2>/dev/null || true', "lazuli", this.file], { on: this.on, timeout: 10000 });
      const [size, ...type] = r.stdout.split("\n");
      return { size: /^\d+$/.test(size.trim()) ? Number(size.trim()) : null, type: type.join(" ").trim() || null };
    } catch {
      return { size: null, type: null };
    }
  }

  /** The file's text now: `{text, tooLarge}` (over 1 MiB: its head; null text: deleted), `{binary:
   *  true}` when it is no longer UTF-8, or null when it cannot be read just now. */
  async readDisk(file) {
    try {
      return { text: await readTextFile(file, { on: this.on }), tooLarge: false };
    } catch (e) {
      const why = said(e);
      if (/exceeds 1 MiB/i.test(why)) {
        const head = await this.readHead();
        return head === null ? null : { text: head, tooLarge: true };
      }
      return /valid UTF-8/i.test(why) ? { binary: true } : null;
    }
  }

  /** The file read again: reloaded when there are no edits to lose (read-only files never have any;
   *  their editability is decided afresh, so a file that shrank below the limit becomes editable),
   *  else kept in `conflict`. */
  async checkDisk() {
    this.lastCheck = Date.now();
    const { file } = this;
    if (this.status === "missing" || this.status === "error") {
      const now = await readTextFile(file, { on: this.on }).catch(() => undefined);
      if (now !== null && this.file === file) await this.load();
      return;
    }
    if (this.status !== "ready" || this.saving) return;
    if (this.kind === "image") return this.pictureOf(file);
    if (this.kind === "pdf") return this.checkPdf(file);
    if (!TEXT_KINDS.has(this.kind)) return;
    const r = await this.readDisk(file);
    if (!r || this.saving || this.file !== file) return;
    if (r.binary) {
      // No longer text: clean → shown as what it is now; unsaved edits → the conflict (Reload shows it,
      // Overwrite writes the buffer over that very revision).
      if (!this.dirty) return this.load();
      const revision = await fileRevision(file);
      if (this.file === file && !(this.conflict?.binary && this.conflict.revision === revision)) this.conflict = { disk: "", binary: true, revision };
      return;
    }
    if (r.text === this.disk) {
      this.conflict = null;
      return;
    }
    if (!this.dirty && r.text !== null && !this.conflict) {
      this.fill(r.text, r.tooLarge);
      if (this.kind === "svg" && !this.on) await this.renderSvg(r.text);
    } else this.conflict = { disk: r.text, tooLarge: r.tooLarge };
  }

  /** The editor changed: the buffer, and the dirty marker on a change (a first edit pins, B2). Typing
   *  while a recovered draft is offered keeps both: the offer is withdrawn for now, the offered draft
   *  stays set aside on disk (offered again on the next open) and the new edits get their own draft. */
  edited(text, cx) {
    if (!this.editable || typeof text !== "string") return;
    if (this.draft && text !== this.original) {
      this.draft = null;
      this.draftFrom = null;
    }
    this.buffer = text;
    this.markDirty(text !== this.original);
    if (this.kind === "svg" && !this.on && cx) {
      this.svgTimer?.cancel();
      this.svgTimer = cx.timer.after(SVG_DEBOUNCE_MS, () => this.kick("svg"));
    }
  }

  /** ⌘S: writes the buffer over what was read; a stale save becomes the Reload / Overwrite conflict. */
  save(cx) {
    if (!this.editable || this.saving || this.conflict || this.buffer === this.original) return false;
    this.write(this.buffer, this.disk, cx);
    return true;
  }

  /** The conflict's Overwrite (Save again when the file was deleted): the buffer wins. Not offered
   *  over a file that is no longer text (nothing can replace it only while it is unchanged): that
   *  conflict offers saveCopy instead. */
  overwrite(cx) {
    if (!this.editable || this.saving || !this.conflict || this.conflict.binary) return;
    this.write(this.buffer, this.conflict.disk, cx);
  }

  /** The binary conflict's "Save a copy": the buffer goes to a new file beside this one,
   *  `<name> (lazuli YYYY-MM-DD HH.MM)[ n].<ext>`, written only where nothing is (writeTextFile
   *  expecting no file), so neither the replaced file nor a link to it is touched. Once written,
   *  `copiedTo` holds its path and the draft goes (the edits are on disk now); the conflict stays,
   *  with Reload. Resolves with the path, or null (`failed` says why). */
  saveCopy(cx) {
    if (!this.editable || this.saving || !this.conflict?.binary) return Promise.resolve(null);
    this.saving = true;
    this.failed = null;
    cx.notify();
    return new Promise((resolve) => {
      cx.spawn(async (cx) => {
        let done = null;
        await this.serial(async () => {
          const text = this.buffer;
          try {
            for (const path of copyNames(this.file, new Date())) {
              try {
                await writeTextFile(path, text, null);
                done = path;
                break;
              } catch (e) {
                if ((await readTextFile(path).catch(() => undefined)) === null) throw e;
              }
            }
            if (done) {
              this.copiedTo = done;
              await this.queueDraft(async () => {
                await this.dropDraft();
                this.lastDraftText = text;
              });
            } else this.failed = "no free name";
          } catch (e) {
            this.failed = said(e);
          } finally {
            this.saving = false;
          }
        });
        cx.notify();
        resolve(done);
      });
    });
  }

  /** The conflict's Reload: the disk wins; the edits and their draft go. A file that is no longer
   *  text loads as what it is now (info card); its draft goes only once that load succeeded. */
  reload(cx) {
    if (this.conflict?.binary) {
      const path = this.draftPath();
      cx.spawn(async (cx) => {
        await this.serial(() => this.load());
        if (this.status === "binary") await this.queueDraft(() => removeDraft(path));
        cx.notify();
      });
      return;
    }
    if (typeof this.conflict?.disk !== "string") return;
    cx.spawn(async (cx) => {
      await this.serial(async () => {
        if (typeof this.conflict?.disk !== "string") return;
        this.fill(this.conflict.disk, this.conflict.tooLarge === true);
        await this.queueDraft(() => this.dropDraft());
        if (this.kind === "svg" && !this.on) await this.renderSvg(this.buffer);
      });
      cx.notify();
    });
  }

  /** The disk now, after a refused write: the conflict it makes, or null when it is what was expected. */
  async conflictNow(expected) {
    const r = await this.readDisk(this.file);
    if (r?.binary) return { disk: "", binary: true, revision: await fileRevision(this.file) };
    return r && r.text !== expected ? { disk: r.text, tooLarge: r.tooLarge } : null;
  }

  saved(text) {
    this.disk = text;
    this.diskHash = sha1(text);
    this.original = text;
    this.conflict = null;
    this.copiedTo = null;
    this.markDirty(this.buffer !== text);
  }

  write(text, expected, cx) {
    this.saving = true;
    this.failed = null;
    cx.notify();
    cx.spawn(async (cx) => {
      await this.serial(async () => {
        try {
          await writeTextFile(this.file, text, expected);
          this.saved(text);
          if (!this.dirty && !this.draft) await this.queueDraft(() => this.dropDraft());
        } catch (e) {
          const conflict = await this.conflictNow(expected);
          if (conflict) this.conflict = conflict;
          else this.failed = said(e);
        } finally {
          this.saving = false;
        }
      });
      cx.notify();
    });
  }

  /** A PDF replaced on disk: `revision` goes up, so the tab opens it again (its PdfClient reload()). */
  async checkPdf(file) {
    const stamp = await fileRevision(file);
    if (this.file !== file || stamp === this.pdfStamp) return;
    this.pdfStamp = stamp;
    if (stamp === null) this.status = "missing";
    else this.revision += 1;
  }

  // Drafts (B5): one per tab's buffer (sys/filetabs.js draftPathOf), written every second while dirty.

  draftPath() {
    return draftPathOf(this.file, this.on, this.fid);
  }

  /** The banner on open, one draft at a time: this buffer's own draft, else one of its drafts set
   *  aside before, else the newest draft of this file whose tab no longer exists (never one a live
   *  tab owns). The offered draft is kept apart in `draftFrom` (the buffer's own draft is first moved
   *  aside, atomically), so autosaves of new edits never write over it. Drafts equal to the disk text
   *  are deleted. `text` null: the file is gone (every non-empty draft is offered, as changed since).
   *  Only from a queueDraft job. */
  async findDraft(text) {
    const disk = { file: this.file, on: this.on, text: text ?? "", hash: text === null ? null : this.diskHash };
    const found = await listDrafts(this.file, this.on, this.fid);
    this.draftOnDisk = false;
    this.draftFrom = null;
    this.draft = null;
    for (const o of [...(found.own ? [found.own] : []), ...found.aside, ...found.orphans]) {
      const r = decide(o.draft, disk);
      if (r.remove) {
        await fs.unlink(o.path).catch(() => {});
        continue;
      }
      if (!r.banner) continue;
      let from = o.path;
      if (o === found.own) {
        // Set aside before offering; if that cannot be done the draft is offered where it is (it is
        // never written in place, so autosaves leave it as it is).
        const aside = asidePathOf(this.file, this.on, this.fid, o.draft.at);
        try {
          await writeAtomic(aside, JSON.stringify(o.draft));
          await fs.unlink(o.path).catch(() => {});
          from = aside;
        } catch {
          this.draftError = "not-replaced";
        }
      }
      this.draft = { text: o.draft.text, at: o.draft.at, baseChanged: r.baseChanged };
      this.draftFrom = from;
      return;
    }
  }

  /** The banner's Restore: the recovered text becomes the buffer (dirty until saved). A draft taken
   *  over from a closed tab becomes this buffer's own. A file deleted since becomes a new buffer whose
   *  save creates it again (expecting no file there). */
  restoreDraft(cx) {
    if (!this.draft) return;
    if (this.status === "missing" && !this.on && TEXT_KINDS.has(this.kind)) {
      this.status = "ready";
      this.disk = null;
      this.diskHash = null;
      this.original = "";
      this.readOnly = !this.writable;
      this.reason = this.writable ? null : "not-writable";
      this.truncated = false;
      this.conflict = null;
      this.failed = null;
    }
    if (!this.editable) return;
    const text = this.draft.text;
    const from = this.draftFrom;
    this.draft = null;
    this.draftFrom = null;
    this.replace(text);
    this.edited(text, cx);
    if (from) {
      this.queueDraft(async () => {
        await this.writeDraft();
        if (from !== this.draftPath()) await fs.unlink(from).catch(() => {});
      });
    }
    cx.notify();
  }

  /** The banner's Discard: the offered draft goes (this buffer's own only while it has no edits). */
  discardDraft(cx) {
    if (!this.draft) return;
    const from = this.draftFrom;
    this.draft = null;
    this.draftFrom = null;
    cx.spawn(async (cx) => {
      await this.queueDraft(async () => {
        if (from) {
          await fs.unlink(from).catch(() => {});
          if (from.startsWith(this.draftPath())) await removeDraft(this.draftPath());
        } else if (!this.dirty) await this.dropDraft();
      });
      cx.notify();
    });
  }

  /** This buffer's draft I/O, one job at a time in order: a close's last write lands after an autosave
   *  still under way, never before it. Resolves when `fn` is done (failures are logged). */
  queueDraft(fn) {
    const job = this.draftQueue.then(fn).catch((e) => log(`draft of ${this.file}: ${errText(e)}`));
    this.draftQueue = job;
    return job;
  }

  /** Deletes this buffer's draft (and a copy kept beside it). Only from a queueDraft job. */
  async dropDraft() {
    this.lastDraftText = null;
    if (!this.draftOnDisk) return;
    this.draftOnDisk = false;
    await removeDraft(this.draftPath());
  }

  /** Writes the buffer as this buffer's draft, whole or not at all. Only from a queueDraft job. When
   *  the draft cannot be replaced, the previous one stays, a complete copy is kept beside it (newest
   *  wins on the next open), `draftError` says so and the next tick tries again; it throws then, so a
   *  job chained after it does not go on. */
  async writeDraft(now = Date.now()) {
    const text = this.buffer;
    // Path and content name the same file even if a rename lands during the write.
    const path = this.draftPath();
    const json = JSON.stringify(makeDraft({ file: this.file, on: this.on, baseHash: this.diskHash, text, now }));
    await fs.mkdir(draftDir(), { recursive: true });
    try {
      await writeAtomic(path, json);
    } catch (e) {
      this.draftError = "not-replaced";
      this.draftOnDisk = true;
      this.lastDraftAt = now;
      throw e;
    }
    this.draftError = null;
    this.lastDraftText = text;
    this.lastDraftAt = now;
    this.draftOnDisk = true;
  }

  tick(cx) {
    if (this.closed) return;
    // Herdr may draw no frame for a while (render, the fast path, not called): the tab is found here
    // too, outside render, before anything that needs the registry entry.
    resolveOwn(this.fid, { file: this.file, on: this.on, preview: this.preview, mode: this.wantMode }, { render: false });
    this.track();
    const now = Date.now();
    if (!this.draftBusy && this.editable) {
      const write = shouldWrite({ dirty: this.dirty, text: this.buffer, lastText: this.lastDraftText, lastAt: this.lastDraftAt, now });
      if (write || (!this.dirty && this.draftOnDisk && !this.draft)) {
        this.draftBusy = true;
        this.queueDraft(() => (write ? this.writeDraft() : this.dropDraft())).finally(() => (this.draftBusy = false));
      }
    }
    // The tab shows the registry's name (preview marker, file), also for a pin or retarget that came
    // before its id was known (sys/filetabs.js tickName).
    tickName(this.fid);
    const shown = this.isShown();
    if (shown !== this.shown) {
      this.shown = shown;
      if (shown) {
        this.watchStart(cx);
        this.kick("disk");
      } else this.watchStop();
    } else if (shown && now - this.lastCheck >= CHECK_MS) this.kick("disk");
    this.syncViewer();
  }

  /** The tab is the shown space's active tab. */
  isShown() {
    const tab = entryOf(this.fid)?.tab;
    return Boolean(tab) && spaces().some((s) => s.active && (s.tabs ?? []).some((t) => t.id === tab && t.active));
  }

  // One watchFolder for the shown tab's folder (local only; remote files are polled by the tick).
  watchStart(cx) {
    if (this.on || this.watching || this.closed) return;
    this.watching = true;
    const dir = dirname(this.file);
    cx.spawn(async (cx) => {
      while (this.watching && !this.closed && dirname(this.file) === dir) {
        const w = watchFolder(dir);
        this.watch = w;
        let paths;
        try {
          paths = await w;
        } catch (e) {
          log(`watch ${dir}: ${errText(e)}`);
          await cx.sleep(CHECK_MS);
          continue;
        }
        if (!this.watching || this.closed) return;
        let mine = false;
        let pictures = false;
        for (const p of paths) {
          const path = normalize(p);
          if (path === this.file || path === dir) mine = true;
          if (forgetSource(path)) pictures = true;
        }
        if (mine) this.kick("disk");
        else if (pictures) this.kick("redraw");
      }
    });
  }

  watchStop() {
    this.watching = false;
    this.watch?.cancel();
    this.watch = null;
  }

  // Pictures (B3, B6).

  async pictureOf(file) {
    const r = await cacheImage(file, { on: this.on });
    if (this.file !== file) return;
    this.imagePath = r.path ?? null;
    this.imageError = r.error ?? null;
  }

  async renderSvg(text) {
    const r = await cacheText(text, "svg");
    if (r.path) this.imagePath = r.path;
    this.imageError = r.error ?? null;
  }

  /** A Markdown image → `{state: "ready", path}` (for image()), `{state: "loading"}`, `{state: "url",
   *  url}` (remote: alt text and a link) or `{state: "error", code}`. Safe in render. */
  image(src) {
    const link = resolveLink(src, dirname(this.file));
    if (link.kind === "url") return { state: "url", url: link.url };
    if (link.kind !== "file") return { state: "error", code: "unsupported" };
    if (this.on) return { state: "error", code: "remote" };
    const { stale, ...hit } = lookupImage(link.path);
    if (stale) {
      this.wantImages.add(link.path);
      this.kick("images");
    }
    return hit;
  }

  // Modes (B3) and the viewer pane (B7).

  /** The mode the panes show. An HTML tab with a viewer decides by its pane (none → edit, beside →
   *  split, zoomed → preview), unless a change is still being applied. Without a browser (or before
   *  that is known) Split and Preview show html-fallback, so the wanted mode is the shown one; so it
   *  is for every other kind. */
  shownMode() {
    if (this.kind !== "html" || this.on || this.status !== "ready" || this.browser !== true || this.viewerPending) return this.mode;
    const have = this.viewer().have;
    return have === "none" ? "edit" : have === "split" ? "split" : have === "zoomed" ? "preview" : this.mode;
  }

  setMode(mode) {
    if (!this.modes.includes(mode)) return false;
    const changed = mode !== this.mode;
    this.mode = mode;
    saveMode(this.fid, mode);
    if (this.kind === "html") this.wantViewer();
    return changed;
  }

  /** ⌘⇧V: the next available mode after the one shown. */
  cycleMode() {
    const next = nextMode(this.kind, this.shownMode(), { remote: Boolean(this.on) });
    return next ? this.setMode(next) : false;
  }

  /** Markdown "View in Chrome" (B6): the viewer beside the editor, on the saved file. */
  openChrome() {
    if (this.kind !== "md" || this.on) return;
    this.chrome = true;
    this.wantViewer();
  }

  closeChrome() {
    this.chrome = false;
    this.wantViewer();
  }

  /** A change the viewer panes must follow; the next tick applies it (safe from render). */
  markViewer() {
    this.viewerPending = true;
    this.viewerSince = Date.now();
  }

  /** A change the viewer panes must follow, applied now (never from render). */
  wantViewer() {
    this.markViewer();
    this.syncViewer();
  }

  /** The viewer pane: `{want, have, pane, steps, fallback}` (file/viewer.js). */
  viewer() {
    const e = entryOf(this.fid);
    return viewerState({
      fid: this.fid, file: this.file, kind: this.kind, mode: this.mode, on: this.on, ready: this.status === "ready",
      chrome: this.chrome, browser: this.browser, tab: e?.tab ?? null, pane: e?.pane ?? null,
      viewerFile: this.viewerFile, splitAt: this.splitAt, now: Date.now(),
    });
  }

  /** Every tick, shown or not: the viewer panes brought to what the file and mode want (a fresh
   *  tab, the browser becoming known, a restored mode, a retarget, a failed split tried again after
   *  the grace). A change the person made to the panes themselves (closed the viewer, zoomed it in
   *  or out) becomes the wanted state instead of being undone. */
  syncViewer() {
    let v = this.viewer();
    if (v.have === "unknown") return v;
    const seen = this.viewerSeen;
    const target = v.fallback ? "none" : v.want;
    if (!this.viewerPending && (seen === "split" || seen === "zoomed") && v.have !== seen && v.have !== target) {
      // Our own steps may still be landing: look again next tick before taking it as the person's.
      if (Date.now() - this.viewerStepAt < VIEWER_SETTLE_MS) return v;
      this.adoptViewer(v.have);
      v = this.viewer();
    }
    // A viewer is split only once a browser is known to exist.
    if (this.browser === null && v.want !== "none") {
      this.viewerSeen = v.have;
      return v;
    }
    // A Markdown page zoomed by the person stays zoomed.
    if (this.kind === "md" && v.want === "split" && v.have === "zoomed") v = { ...v, steps: v.steps.filter((s) => s.command !== "pane.zoom") };
    return this.applyViewer(v);
  }

  /** The panes as the person left them become the wanted state. */
  adoptViewer(have) {
    if (this.kind === "html") {
      const mode = have === "none" ? "edit" : have === "split" ? "split" : "preview";
      if (this.modes.includes(mode) && mode !== this.mode) {
        this.mode = mode;
        saveMode(this.fid, mode);
      }
    } else if (this.kind === "md" && have === "none") this.chrome = false;
  }

  /** Runs the viewer's steps once (`v`: a viewer() state, by default the current one). A change stays
   *  pending until the panes match or 10 s pass; the tick keeps trying either way. */
  applyViewer(v = this.viewer()) {
    if (v.have === "unknown") return v;
    for (const s of v.steps) {
      try {
        run(s.command, s.args);
      } catch (e) {
        log(`${s.command} failed: ${errText(e)}`);
      }
      if (s.command === "pane.split") {
        this.splitAt = Date.now();
        this.viewerFile = this.file;
      }
    }
    // What the panes are once these steps apply: a later change that is not this came from the person.
    let after = v.have;
    for (const s of v.steps) {
      if (s.args.pane !== v.pane) continue;
      if (s.command === "pane.close") after = "none";
      else if (s.command === "pane.zoom") after = after === "zoomed" ? "split" : "zoomed";
    }
    if (v.steps.length) this.viewerStepAt = Date.now();
    if (v.have !== "none" && this.viewerFile === null) this.viewerFile = this.file;
    // Settled once the panes match: a split whose title is not up yet keeps it pending.
    const target = v.fallback ? "none" : v.want;
    const settled = !v.steps.length && (v.have === target || (this.kind === "md" && target === "split" && v.have === "zoomed"));
    if (settled || Date.now() - this.viewerSince > VIEWER_WAIT_MS) this.viewerPending = false;
    this.viewerSeen = after;
    return v;
  }

  /** "Open in default app" (B3 info card), local files only. */
  async openExternal() {
    if (this.on) return false;
    try {
      return (await exec("open", [this.file])).code === 0;
    } catch {
      return false;
    }
  }

  /** The copy goes (≤250 ms): watches stop; a dirty buffer gets one last draft, queued behind any
   *  draft write still under way so the newest text lands last. */
  async close() {
    this.closed = true;
    this.watchStop();
    this.svgTimer?.cancel();
    const wake = this.wake;
    this.wake = null;
    wake?.();
    forget(this.fid);
    await this.queueDraft(() => (this.editable && this.dirty && this.buffer !== this.lastDraftText ? this.writeDraft() : null));
  }
}
