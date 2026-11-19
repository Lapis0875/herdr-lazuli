// The Files panel (`view: "files"`, DESIGN A3, B1, B2, B10): the focused pane's folder as a lazy tree (port of
// lstack-herdr's lh-files.js (removed; git history ee5201a) tree, after Herdr's shipped `files` mod, Apache-2.0):
// folders load when opened, git
// marks (M U A D C) with a dot on folders holding changes, 500 entries a folder and 5,000 in all. A click opens the
// file in a center tab of the followed space as its preview tab; a double click opens it as a normal tab. The file
// of the focused file tab is highlighted; a file shown in the space's preview tab carries an eye.
//   Files:   new file and new folder in the header (the top level) and on a folder's row (inside it), rename and
//            delete on every row (shown while the pointer is on it). A name is typed where it will be (⏎ makes it,
//            esc cancels) and refused, with why, when empty, `.`/`..`, holding a /, or taken. A delete always stops
//            at a confirm whose default is Cancel (⏎ and esc cancel, only its own button deletes); on this Mac it
//            goes to the Trash, else it is gone for good, and for a folder the confirm counts what goes with it.
//   Remote:  a space on another machine is listed read-only (B10): no new, rename or delete.
// A focus on a file tab keeps the folder in view when the file is inside it. A preview copy lists once and opens
// nothing.
//
// Commands (palette, keys, `herdr-app do`, while the panel shows): `files:new[:<folder>]`, `files:mkdir[:<folder>]`,
// `files:rename:<path>`, `files:delete:<path>`, `files:input:type:<name>`, `files:input:submit`,
// `files:input:cancel`, `files:confirm:delete`, `files:confirm:cancel`, `files:collapse`; paths from the folder.

import { div } from "gpui-kit";
import { h_flex, v_flex, InputState } from "gpui-base";
import { props, home, checking, watchFolder, focused, panes, terminals } from "herdr";
import { t } from "../core/i18n.js";
import { tokens } from "../ui/tokens.js";
import { ViewRoot, Text, Icon, IconButton, Spacer, trackFocus } from "../ui/kit.js";
import { context, open as openFile, registry } from "../sys/filetabs.js";
import { invalidName, tilde, dirname } from "../core/paths.js";
import {
  PER_FOLDER, TOTAL, directory, gitMarks, createFile, createFolder, renameEntry, identify, deleteEntry, folderContents, trashes, canOperate,
} from "./files-ops.js";
import { DeleteConfirm, FailedNotice } from "./panels/files-parts.js";
import { treeRows } from "./panels/files-rows.js";
import { blockShown } from "./panels/common.js";

const REFRESH_MS = 10000;

/** `p` after `from` became `to`: unchanged when neither `from` nor under it; null when `to` is null (deleted). */
const moved = (p, from, to) => (p === from ? to : p.startsWith(`${from}/`) ? (to === null ? null : `${to}${p.slice(from.length)}`) : p);

export default class FilesTree {
  constructor(name) {
    this.name = name;
  }

  init(_props, cx) {
    this.p = props() ?? {};
    this.preview = this.p.preview === true;
    this.saved = new Map(); // folder key → open folders, for when the focus comes back
    this.context = null; // {key, cwd, on, space}
    this.entries = new Map();
    this.folders = new Set();
    this.pending = new Set();
    this.marks = {};
    this.branch = null;
    this.error = null;
    this.limited = false;
    this.loading = false;
    this.stale = false;
    this.selected = null; // the focused file tab's file (absolute)
    this.space = null;
    this.edit = null; // {kind: "new" | "rename", dir, folder, path, name, error, busy}
    this.ask = null; // {path, abs, on, trash, dir, contents, busy}
    this.failed = null;
    this.hover = null;
    this.trashCheck = null;
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: t("files.field.placeholder") });
    this.inputFocus = trackFocus(this.input);
    this.input.on("submit", (_e, cx) => this.submit(cx));
    this.input.on("change", (_e, cx) => {
      if (!this.edit?.error) return;
      this.edit.error = null;
      cx.notify();
    });
    this.follow();
    this.refresh(cx);
    // While the panel is hidden the folder watch keeps it current; the timer reads only what someone sees.
    if (!this.preview && !checking()) cx.timer.every(REFRESH_MS, (cx) => blockShown("files") && this.refresh(cx));
  }

  close() {
    this.closed = true;
    this.watch?.cancel();
    this.input.release();
  }

  focus() {
    this.handle.focus();
  }

  current(ctx) {
    return this.context === ctx;
  }

  /** The place a lazuli HTML/Markdown viewer pane belongs to (its terminal runs in ~): its file tab's folder and
   *  file, by the label `lazuli.view=<fid>` or the title `lazuli-view:<fid8>`. `{}` for any other pane, including a
   *  shell that only kept a `lazuli.view` label of a tab that is gone; null for a pane whose title says it is a
   *  viewer but whose file tab is unknown (the tree then keeps what it shows). */
  viewerPlace(f) {
    if (!f?.terminal) return {};
    const term = (terminals() ?? []).find((x) => x.address === f.terminal);
    const pane = f.pane ? (panes() ?? []).find((p) => p.pane === f.pane) : null;
    const fid = term?.labels?.["lazuli.view"] ?? null;
    const fid8 = /^lazuli-view:(\S+)/.exec(term?.title || pane?.title || "")?.[1] ?? null;
    if (!fid && !fid8) return {};
    const reg = registry();
    const key = fid && reg[fid] ? fid : Object.keys(reg).find((k) => fid8 && k.startsWith(fid8));
    const e = key ? reg[key] : null;
    if (typeof e?.file === "string") return { space: e.space ?? f.space ?? null, cwd: dirname(e.file), on: e.on ?? null, file: e.file };
    // A label alone (no viewer title) is a leftover on a terminal that runs something else now: an ordinary pane.
    return fid8 ? null : {};
  }

  /** The folder in view follows the focused pane; a file tab whose file is inside it keeps it. True on a change. */
  follow() {
    const ctx = this.context;
    const f = focused();
    // A focus on a layout block (this panel, the sidebar) names no folder: the tree stays where it is.
    if (ctx && !f?.pane && !f?.terminal) return false;
    // A lazuli viewer pane runs in ~: the tree follows its file tab instead (or stays, when that is unknown).
    const viewer = this.viewerPlace(f);
    if (viewer === null) return false;
    const at = viewer.cwd ? viewer : context();
    this.space = at.space ?? this.space;
    this.selected = at.file ?? null;
    if (at.file && ctx && (ctx.on ?? null) === (at.on ?? null) && at.file.startsWith(`${ctx.cwd === "/" ? "" : ctx.cwd}/`)) return false;
    const cwd = at.cwd;
    const key = JSON.stringify({ cwd, on: at.on ?? null });
    if (key === ctx?.key) return false;
    if (ctx) this.saved.set(ctx.key, new Set(this.folders));
    this.watch?.cancel();
    this.watch = null;
    this.context = { key, cwd, on: at.on ?? null };
    this.entries = new Map();
    this.folders = new Set(this.saved.get(key) ?? []);
    this.pending = new Set();
    this.marks = {};
    this.branch = null;
    this.error = null;
    this.limited = false;
    this.loading = false;
    this.stale = false;
    this.edit = null;
    this.ask = null;
    this.failed = null;
    return true;
  }

  watchLoop(ctx, cx) {
    if (ctx.on || this.watch || this.preview || checking()) return;
    cx.spawn(async (cx) => {
      while (this.current(ctx) && !this.closed) {
        this.watch = watchFolder(ctx.cwd);
        let changed;
        try {
          changed = await this.watch;
        } catch {
          break;
        }
        if (!changed?.length || !this.current(ctx)) break;
        this.reread(cx);
      }
      if (this.current(ctx)) this.watch = null;
    });
  }

  async loadFolder(path, ctx) {
    const listed = await directory(path ? `${ctx.cwd}/${path}` : ctx.cwd, ctx.on);
    if (!this.current(ctx) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, listed.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (listed.length > PER_FOLDER || used + listed.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    if (this.closed || checking()) return;
    this.follow();
    const ctx = this.context;
    if (!ctx?.cwd || this.loading) return;
    this.loading = true;
    this.limited = false;
    cx.spawn(async (cx) => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(ctx)) return;
          await this.loadFolder(path, ctx);
        }
        const g = await gitMarks(ctx.cwd, ctx.on);
        if (!this.current(ctx)) return;
        this.marks = g.marks;
        this.branch = g.branch;
        this.error = null;
        this.watchLoop(ctx, cx);
      } catch (e) {
        if (this.current(ctx)) this.error = String(e?.message ?? e);
      } finally {
        if (this.current(ctx)) {
          this.loading = false;
          if (this.stale) {
            this.stale = false;
            this.refresh(cx);
          }
        }
        cx.notify();
      }
    });
  }

  reread(cx) {
    if (this.loading) this.stale = true;
    else this.refresh(cx);
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const f of [...this.folders]) {
        if (f === path || f.startsWith(`${path}/`)) {
          this.folders.delete(f);
          this.entries.delete(f);
        }
      }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const ctx = this.context;
        this.pending.add(path);
        cx.spawn(async (cx) => {
          try {
            await this.loadFolder(path, ctx);
          } catch (e) {
            if (this.current(ctx)) this.error = String(e?.message ?? e);
          } finally {
            if (this.current(ctx)) this.pending.delete(path);
            cx.notify();
          }
        });
      }
    }
    cx.notify();
  }

  collapse(cx) {
    this.folders = new Set();
    for (const p of [...this.entries.keys()]) if (p) this.entries.delete(p);
    cx.notify();
  }

  /** A file row's click: its preview tab, or (a second click) a normal tab, in the followed space (B2). */
  openPath(path, pin) {
    const ctx = this.context;
    if (!ctx?.cwd || this.preview) return;
    openFile(`${ctx.cwd}/${path}`, { on: ctx.on, space: this.space ?? undefined, ...(pin ? { pin: true } : { preview: true }) });
  }

  // ---------------------------------------------------------------------------------------------------------------
  // New, rename, delete. files-ops.js runs them; this side asks first.

  ops() {
    return !this.preview && Boolean(this.context?.cwd) && canOperate(this.context.on);
  }

  busy() {
    return Boolean(this.edit?.busy || this.ask?.busy);
  }

  entry(path) {
    const at = path.lastIndexOf("/");
    return (this.entries.get(at < 0 ? "" : path.slice(0, at)) ?? []).find((e) => e.name === path.slice(at + 1)) ?? null;
  }

  startNew(folder, cx, dir = false) {
    if (!this.ops() || this.busy() || (folder && !this.entry(folder)?.dir)) return;
    if (folder && !this.folders.has(folder)) this.toggle(folder, cx);
    this.openField({ kind: "new", dir, folder }, "");
  }

  startRename(path, cx) {
    const listed = this.entry(path);
    if (!this.ops() || this.busy() || !listed) return;
    const name = path.split("/").pop();
    // A file's name before its extension is selected: typing replaces it and keeps the extension.
    const dot = listed.dir ? -1 : name.lastIndexOf(".");
    this.openField({ kind: "rename", dir: listed.dir, folder: path.slice(0, Math.max(0, path.lastIndexOf("/"))), path, name }, name, { start: 0, end: dot > 0 ? dot : name.length });
    cx.notify();
  }

  openField(edit, value, selected = null) {
    this.edit = { ...edit, error: null, busy: false };
    this.ask = null;
    this.failed = null;
    this.input.set_value(value);
    if (selected) this.input.set_selected_range(selected);
    this.input.focus();
  }

  type(text) {
    if (!this.edit || this.edit.busy) return;
    this.input.set_value(text);
    this.edit.error = null;
  }

  cancelEdit(cx) {
    if (!this.edit || this.edit.busy) return;
    this.edit = null;
    this.handle.focus();
    cx.notify();
  }

  /** ⏎ in the name field: a refused name stays with why; the same name closes it; a new file opens in a tab. */
  submit(cx) {
    const e = this.edit;
    if (!e || e.busy) return;
    const ctx = this.context;
    const name = this.input.value();
    if (e.kind === "rename" && name === e.name) return this.cancelEdit(cx);
    const siblings = (this.entries.get(e.folder) ?? []).map((x) => x.name).filter((n) => n !== e.name);
    const why = invalidName(name, siblings);
    if (why) {
      e.error = t(`files.name.${why}`);
      return cx.notify();
    }
    const path = e.folder ? `${e.folder}/${name}` : name;
    const abs = `${ctx.cwd}/${path}`;
    e.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = e.kind === "rename" ? await renameEntry(`${ctx.cwd}/${e.path}`, abs, ctx.on) : e.dir ? await createFolder(abs, ctx.on) : await createFile(abs, ctx.on);
      e.busy = false;
      if (r.ok && e.kind === "rename") {
        this.remember(ctx, e.path, path);
        if (e.dir && this.current(ctx)) this.retarget(e.path, path);
      }
      if (this.current(ctx)) {
        if (r.taken) e.error = t("files.name.taken");
        else if (this.edit === e) {
          this.edit = null;
          this.handle.focus();
        }
        if (r.failed) this.failed = t(e.kind === "rename" ? "files.failed.rename" : e.dir ? "files.failed.mkdir" : "files.failed.new", { why: r.failed });
        await this.loadFolder(e.folder, ctx).catch(() => {});
        this.reread(cx);
        if (r.ok && e.kind === "new" && !e.dir) this.openPath(path, true);
      }
      cx.notify();
    });
  }

  /** The delete confirm, never the deletion. What the entry is (kind, identity, a link's target), Trash or not,
   *  and a folder's contents are settled first; the delete itself only removes that same entry. `changed`: the
   *  confirm opens again because what it showed before was replaced. */
  startDelete(path, cx, changed = false) {
    const listed = this.entry(path);
    if (!this.ops() || this.busy() || !listed) return;
    const ctx = this.context;
    const abs = `${ctx.cwd}/${path}`;
    if (!this.trashCheck) this.trashCheck = trashes(ctx.on);
    cx.spawn(async (cx) => {
      const ident = await identify(abs, ctx.on);
      if (!this.current(ctx) || this.busy()) return;
      if (!ident.kind) {
        this.ask = null;
        this.failed = t("files.failed.delete", { why: ident.missing ? t("files.failed.missing") : ident.failed });
        this.reread(cx);
        return cx.notify();
      }
      const [trash, contents] = await Promise.all([this.trashCheck, ident.kind === "dir" ? folderContents(abs, ctx.on) : null]);
      if (!this.current(ctx) || this.busy()) return;
      this.edit = null;
      this.failed = null;
      // A link goes alone; `toFolder` only says what the dialog tells about it.
      this.ask = { path, abs, on: ctx.on, trash, ident, toFolder: ident.kind === "link" && listed.dir, contents, changed, busy: false };
      this.handle.focus();
      cx.notify();
    });
  }

  cancelDelete(cx) {
    if (!this.ask || this.ask.busy) return;
    this.ask = null;
    cx.notify();
  }

  confirmDelete(cx) {
    const a = this.ask;
    if (!a || a.busy) return;
    const ctx = this.context;
    a.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await deleteEntry(a.abs, a.on, a.trash, a.ident);
      if (this.ask === a) this.ask = null;
      const parent = a.path.slice(0, Math.max(0, a.path.lastIndexOf("/")));
      if (r.ok) {
        this.remember(ctx, a.path, null);
        if (a.ident.kind === "dir" && this.current(ctx)) this.retarget(a.path, null);
      } else if (r.changed && this.current(ctx)) {
        // Not what the confirm showed any more: nothing was deleted; ask again about what is there now.
        await this.loadFolder(parent, ctx).catch(() => {});
        if (this.entry(a.path)) this.startDelete(a.path, cx, true);
        else this.failed = t("files.failed.delete", { why: t("files.failed.missing") });
      } else if (r.stranded && this.current(ctx)) {
        // Not deleted, and its name was taken meanwhile: it waits in the holding folder; say where.
        this.failed = t("files.failed.stranded", { path: tilde(r.stranded, home()) });
      } else if (this.current(ctx)) {
        this.failed = t(a.trash ? "files.failed.trash" : "files.failed.delete", { why: r.failed ?? t("files.failed.missing") });
      }
      if (this.current(ctx)) {
        await this.loadFolder(parent, ctx).catch(() => {});
        this.reread(cx);
      }
      cx.notify();
    });
  }

  /** Other places on the same folder remember their open folders by path: a rename moves them, a delete drops them. */
  remember(ctx, from, to) {
    for (const [key, folders] of this.saved) {
      const at = JSON.parse(key);
      if (at.cwd !== ctx.cwd || (at.on ?? null) !== (ctx.on ?? null)) continue;
      this.saved.set(key, new Set([...folders].map((p) => moved(p, from, to)).filter(Boolean)));
    }
  }

  /** After a folder `from` became `to` (null: deleted), what was open in it follows. */
  retarget(from, to) {
    this.folders = new Set([...this.folders].map((p) => moved(p, from, to)).filter(Boolean));
    const entries = new Map();
    for (const [p, e] of this.entries) {
      const now = moved(p, from, to);
      if (now !== null) entries.set(now, e);
    }
    this.entries = entries;
    for (const p of [...this.pending]) if (moved(p, from, to) !== p) this.pending.delete(p);
  }

  command(c, cx) {
    if (typeof c !== "string" || !c.startsWith("files:")) return;
    const rest = (prefix) => c.slice(prefix.length);
    if (c === "files:new") this.startNew("", cx);
    else if (c.startsWith("files:new:")) this.startNew(rest("files:new:"), cx);
    else if (c === "files:mkdir") this.startNew("", cx, true);
    else if (c.startsWith("files:mkdir:")) this.startNew(rest("files:mkdir:"), cx, true);
    else if (c.startsWith("files:rename:")) this.startRename(rest("files:rename:"), cx);
    else if (c.startsWith("files:delete:")) this.startDelete(rest("files:delete:"), cx);
    else if (c.startsWith("files:input:type:")) this.type(rest("files:input:type:"));
    else if (c === "files:input:submit") this.submit(cx);
    else if (c === "files:input:cancel") this.cancelEdit(cx);
    else if (c === "files:confirm:delete") this.confirmDelete(cx);
    else if (c === "files:confirm:cancel") this.cancelDelete(cx);
    else if (c === "files:collapse") this.collapse(cx);
    cx.notify();
  }

  key(e, cx) {
    if (e.keystroke !== "escape" && e.keystroke !== "enter") return false;
    if (this.ask) {
      // The confirm's default is Cancel: ⏎ and esc both keep the file.
      this.cancelDelete(cx);
      return true;
    }
    if (this.edit && e.keystroke === "escape") {
      this.cancelEdit(cx);
      return true;
    }
    return false;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // Drawing

  render(cx) {
    if (this.follow() && !this.preview) this.refresh(cx);
    const k = tokens();
    return ViewRoot("files-root")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (this.key(e, cx)) cx.stop_propagation();
      })
      .child(this.head(k))
      .when(Boolean(this.context?.cwd), (e) => e.child(this.rootRow(k)))
      .when(Boolean(this.ask), (e) => e.child(DeleteConfirm(this, k)))
      .when(!this.ask && Boolean(this.failed), (e) => e.child(FailedNotice(this)))
      .child(this.tree(k));
  }

  head(k) {
    const ops = this.ops();
    const busy = this.busy();
    return h_flex()
      .h(40)
      .flex_none()
      .pl(12)
      .pr(6)
      .gap(2)
      .items_center()
      .border_b_1()
      .border_color(k.line.soft)
      .child(Text(t("files.title"), { size: "sm", weight: "semibold", nowrap: true }).flex_1())
      .when(ops, (e) =>
        e
          .child(IconButton("files-new", "file-plus", t("files.new"), { disabled: busy, onClick: (_e, cx) => { this.startNew("", cx); cx.notify(); } }))
          .child(IconButton("files-mkdir", "folder-plus", t("files.mkdir"), { disabled: busy, onClick: (_e, cx) => { this.startNew("", cx, true); cx.notify(); } })),
      )
      .child(IconButton("files-collapse", "chevrons-down-up", t("files.collapse"), { disabled: !this.folders.size, onClick: (_e, cx) => this.collapse(cx) }));
  }

  rootRow(k) {
    const { cwd, on } = this.context;
    const name = cwd === "/" ? "/" : cwd.split("/").pop() || cwd;
    return h_flex()
      .id("files-root-row")
      .h(34)
      .flex_none()
      .px(12)
      .gap(7)
      .items_center()
      .tooltip([tilde(cwd, home()), on].filter(Boolean).join(" · "))
      .child(Icon(this.branch ? "folder-git" : "folder", { size: 13, color: k.text.secondary }))
      .child(Text(name, { size: "sm", weight: "semibold", truncate: true }).flex_shrink_1())
      .child(Spacer())
      .when(Boolean(on), (e) => e.child(Text(t("files.readOnly", { machine: on }), { size: "xs", tone: "tertiary", nowrap: true })))
      .when(Boolean(this.branch), (e) =>
        e.child(
          div()
            .flex_none()
            .max_w(160)
            .px(6)
            .py(1)
            .rounded(k.radius.sm)
            .border_1()
            .border_color(k.line.soft)
            .font_family(k.fonts.mono)
            .text_size(k.fontSize.xs)
            .text_color(k.text.secondary)
            .truncate()
            .child(this.branch),
        ),
      );
  }

  tree(k) {
    const rows = treeRows(this, k);
    const naming = this.edit?.kind === "new" && this.edit.folder === "";
    const idle = this.error ?? t(this.loading ? "files.reading" : this.context?.cwd ? "files.empty" : "files.noFolder");
    return v_flex()
      .id("files-tree")
      .flex_1()
      .min_h(0)
      .px(6)
      .pb(6)
      .overflow_y_scrollbar()
      .role("tree")
      .accessibility_label(t("files.title"))
      .children(rows)
      .when(Boolean(this.error) || (!naming && !this.entries.get("")?.length), (e) => e.child(Text(idle, { size: "sm", tone: "tertiary" }).p(8)))
      .when(this.limited, (e) => e.child(Text(t("files.limited", { folder: PER_FOLDER, total: TOTAL.toLocaleString() }), { size: "xs", tone: "tertiary" }).p(8)));
  }
}
