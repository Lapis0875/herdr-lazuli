// The side panel's Files tab (⌃⌘4): the focused pane's folder as a lazy tree, and the file clicked as an editor.
// It stands in for Herdr's shipped `files` mod, whose preview is read-only; sync.mjs points the layout's "files"
// block here.
//   Tree:    ported from mods/files as it shipped beside cockpit 0.38: folders load when opened, git marks, 500
//            entries a folder and 5 000 in all, remote spaces and Windows listed the same way.
//   Editor:  the app's Editor, highlighted by the Sublime grammars it carries (LANG names the nearest one for a
//            language it lacks), saved with ⌘S or 저장. Herdr refuses a save when the file changed on disk since it
//            was read: the notice then offers 다시 불러오기 or 덮어쓰기. A file something else rewrites (an agent)
//            reloads by itself while it has no unsaved edits.
//   Read-only: a remote space's file (Herdr writes here only), one without write permission, one over MAX_EDIT.
//   Files:   새 파일 and 새 폴더 in the header (the folder's top level) and on a folder's row (inside it), 이름 변경
//            and 삭제 on every row (shown while the pointer is on it) and in the open file's header. A name is typed
//            where the file or folder is or will be (⏎ makes it, esc cancels) and refused, with why, when empty, `.`
//            or `..`, holding a /, or taken in its folder. Nothing is overwritten (lh-files-ops.js). A delete always
//            stops at a confirm whose default is 취소: ⏎ and esc cancel, only its own button deletes. On this Mac with
//            macOS 15's trash it moves the file or folder to the Trash, else (another machine) it removes it for good;
//            the confirm says which, and for a folder how many entries go with it (a link to a folder goes alone).
//            A renamed folder stays open as it was, with what was open inside it; a deleted one is forgotten.
// Unsaved edits are never dropped quietly: while a file has them the panel stays on it instead of following the
// focused pane (and once saved, until the focus moves again), and going back to the tree asks first. A rename keeps
// them (the editor follows the file to its new name); a delete says they go with the file.

import { div } from "gpui-kit";
import { v_flex, h_flex, Editor, EditorState, InputState } from "gpui-base";
import { spaces, panes, focused, exec, readTextFile, writeTextFile, watchFolder, theme, settings, home, window as appWindow } from "herdr";
import { tokens, alpha, TEXT, RADIUS, Icon, Button, Mono, TextField, Hover } from "./ui.js";
import { invalidName, createFile, createFolder, renameEntry, deleteFile, deleteFolder, folderContents, trashes, canOperate } from "./lh-files-ops.js";

const PER_FOLDER = 500;
const TOTAL = 5000;
const MAX_EDIT = 400_000;

// The Editor finds a grammar by extension, else by name; one it lacks falls back to plain text. These read well
// enough through a relative (checked on screen); every other extension goes to it as it is.
const LANG = {
  mjs: "js", cjs: "js", jsx: "js", ts: "js", tsx: "js", mts: "js", cts: "js", dart: "js",
  jsonc: "json", json5: "json",
  toml: "properties", ini: "properties", cfg: "properties", env: "properties",
  mdx: "md",
  kt: "scala", kts: "scala",
  swift: "go",
  zig: "rs",
  ex: "rb", exs: "rb",
  scss: "css", less: "css",
  svelte: "html", vue: "html",
  dockerfile: "sh",
};
// Markup whose grammar tells apart only its punctuation (#, **, `, +, -, @@): there the punctuation is the syntax,
// so it is what gets a color.
const MARKUP = new Set(["md", "markdown", "diff", "patch"]);
// Prose wraps; code scrolls sideways.
const PROSE = new Set(["md", "markdown"]);

/** The grammar a file reads through. A name without an extension goes as it is: Makefile, Gemfile, .zshrc. */
function language(name) {
  if (/^(Dockerfile|Containerfile)(\.|$)/.test(name)) return "sh";
  if (/^\.env(\.|$)/.test(name) || name === ".editorconfig") return "properties";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return name;
  const ext = name.slice(dot + 1).toLowerCase();
  return LANG[ext] ?? ext;
}

function palette(lang) {
  const t = theme();
  const colors = { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6, boolean: t.ansi6, "string.escape": t.ansi6 };
  return MARKUP.has(lang) ? { ...colors, punctuation: t.ansi5 } : colors;
}

/** Where the focused pane is: its live folder, on its machine. */
function location() {
  const space = spaces().find((s) => s.active);
  const f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : (space?.machine ?? null);
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}

async function directory(path, on) {
  const windowsDirectory = async () => {
    // Windows PowerShell otherwise uses the console code page; exec decodes UTF-8.
    // Links keep directory attributes even when dangling; check their target.
    // Other reparse points (OneDrive's folders) have no LinkType and are folders.
    // PowerShell reads curly single quotes as quotes too, so they're doubled like '.
    const r = await exec("powershell", ["-NoProfile", "-Command", "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); & { param($p) @(Get-ChildItem -LiteralPath $p -Force -ErrorAction Stop | Where-Object Name -ne '.git' | Select-Object -First 501 | ForEach-Object { @{ name=$_.Name; dir=($_.PSIsContainer -and (-not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -or -not $_.LinkType -or ($_.Target -and [IO.Directory]::Exists(([IO.Path]::Combine([IO.Path]::GetDirectoryName($_.FullName), $_.Target[0])))))) } }) | ConvertTo-Json -Compress } '" + path.replace(/['‘’‚‛]/g, "$&$&") + "'"], { on });
    if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
    const result = JSON.parse(r.stdout || "[]");
    return Array.isArray(result) ? result : [result];
  };
  if (!on && appWindow()?.platform === "windows") return windowsDirectory();
  const script = 'n=0; for p in "$1"/* "$1"/.[!.]* "$1"/..?*; do [ -e "$p" ] || [ -L "$p" ] || continue; name=${p##*/}; [ "$name" = .git ] && continue; if [ -d "$p" ]; then kind=d; else kind=f; fi; printf "%s\\0%s\\0" "$kind" "$name"; n=$((n+1)); [ "$n" -gt 500 ] && break; done; test -d "$1"';
  let r;
  try {
    r = await exec("sh", ["-c", script, "files", path], { on });
  } catch (e) {
    if (on && String(e).includes("cannot start sh: program not found")) return windowsDirectory();
    throw e;
  }
  if (r.code !== 0) throw new Error(r.stderr || "Cannot list this folder");
  const fields = r.stdout.split("\0");
  const out = [];
  for (let i = 0; i + 1 < fields.length; i += 2) out.push({ name: fields[i + 1], dir: fields[i] === "d" });
  return out;
}

const tilde = (p) => {
  const h = home();
  return p === h ? "~" : p?.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
};

/** Herdr's own words for a failure, without the call it came from. */
const said = (e) => String(e?.message ?? e).replace(/^`herdr\.\w+`:\s*/, "");

/** `p` after `from` was renamed to `to`: the same when `p` is neither `from` nor under it; null when `to` is (a delete). */
const moved = (p, from, to) => (p === from ? to : p.startsWith(`${from}/`) ? (to === null ? null : `${to}${p.slice(from.length)}`) : p);

/** 12345 → "12,345". */
const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function unreadable(e) {
  const why = said(e);
  if (/valid UTF-8/i.test(why)) return "바이너리 파일입니다 · 텍스트로 열 수 없습니다";
  if (/exceeds 1 MiB/i.test(why)) return "1 MiB보다 커서 열 수 없습니다";
  return `열 수 없습니다: ${why}`;
}

export default class LhFiles {
  init(_props, cx) {
    // What each folder showed (its open folders, its file), for when the focus comes back to it.
    this.saved = new Map();
    this.context = null;
    this.entries = new Map();
    this.folders = new Set();
    this.pending = new Set();
    this.marks = {};
    this.doc = null;
    this.confirm = false;
    // The focus's folder a file with edits would not follow to: once saved, the file stays until the focus moves again.
    this.held = null;
    this.width = 376;
    // The name field open in the tree or the file's header: { kind: "new" | "rename", dir (a folder), where: "tree" |
    // "head", folder, path and name (what is renamed), error (why the name was refused), busy }.
    this.edit = null;
    this.input = InputState.new({ placeholder: "이름…" });
    this.input.on("submit", (_e, cx) => this.submit(cx));
    this.input.on("change", (_e, cx) => {
      if (!this.edit?.error) return;
      this.edit.error = null;
      cx.notify();
    });
    // The delete confirm: { path, abs, on, trash, dir, contents (a folder's: folderContents), busy }, the file or folder
    // named once, never followed to another.
    this.ask = null;
    // Why the last operation failed, for the notice.
    this.failed = null;
    // The tree was changed here while a read was under way: it is read once more after.
    this.stale = false;
    this.trashCheck = null;
    // The panel's own keyboard, for the confirm's ⏎ and esc.
    this.handle = cx.focus_handle();
    this.hover = new Hover();
    this.refresh(cx);
    cx.timer.every(10000, (cx) => this.refresh(cx));
  }

  close() {
    this.closed = true;
    this.context = null;
    this.setDoc(null);
    this.input.release();
    this.handle.release();
  }

  location() {
    return location();
  }

  current(context) {
    return this.context === context;
  }

  /**
   * The folder in view follows the focused pane; a file with unsaved edits holds it until they are saved or dropped.
   * True when the folder changed (its tree is still to be read).
   */
  follow(cx) {
    const at = this.location();
    const key = JSON.stringify(at);
    if (key === this.context?.key) {
      this.held = null;
      return false;
    }
    if (this.doc && key === this.held) return false;
    if (this.doc?.saving || this.doc?.dirty || this.unsaved(this.doc)) {
      this.held = key;
      return false;
    }
    if (this.context) this.saved.set(this.context.key, { folders: this.folders, file: this.doc?.path ?? null });
    const saved = this.saved.get(key);
    this.context = { key, cwd: at.cwd, on: at.on, watching: false };
    this.entries = new Map();
    this.folders = new Set(saved?.folders);
    this.pending = new Set();
    this.marks = {};
    this.error = null;
    this.limited = false;
    this.loading = false;
    this.stale = false;
    this.edit = null;
    this.ask = null;
    this.failed = null;
    this.setDoc(null);
    if (saved?.file) this.open(saved.file, cx);
    return true;
  }

  watch(context, cx) {
    if (context.on || context.watching) return;
    context.watching = true;
    cx.spawn(async (cx) => {
      try {
        while (this.current(context)) {
          await watchFolder(context.cwd);
          if (this.current(context)) this.refresh(cx);
        }
      } catch {
        context.watching = false;
      }
    });
  }

  async loadFolder(path, context) {
    const entries = await directory(path ? `${context.cwd}/${path}` : context.cwd, context.on);
    if (!this.current(context) || (path && !this.folders.has(path))) return;
    const used = [...this.entries.entries()].filter(([p]) => p !== path).reduce((n, [, e]) => n + e.length, 0);
    this.entries.set(path, entries.slice(0, Math.max(0, Math.min(PER_FOLDER, TOTAL - used))).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)));
    if (entries.length > PER_FOLDER || used + entries.length > TOTAL) this.limited = true;
  }

  refresh(cx) {
    if (this.closed) return;
    this.follow(cx);
    this.checkDisk(cx);
    const context = this.context;
    if (!context?.cwd || this.loading) return;
    const { cwd, on } = context;
    this.loading = true;
    this.limited = false;
    cx.spawn(async (cx) => {
      try {
        for (const path of ["", ...this.folders]) {
          if (!this.current(context)) return;
          await this.loadFolder(path, context);
        }
        const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on }).catch(() => null);
        const marks = {};
        if (top?.code === 0) {
          // Writes nothing under .git (index lock, fsmonitor cookie): the folder watch would refresh again.
          const status = await exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], { cwd, on }).catch(() => null);
          if (status?.code === 0)
            for (const entry of status.stdout.split("\0").filter(Boolean).slice(0, TOTAL)) {
              const xy = entry.slice(0, 2);
              marks[`${top.stdout.trim()}/${entry.slice(3)}`] = xy === "??" || xy.includes("A") ? "A" : xy.includes("U") ? "U" : xy.includes("D") ? "D" : "M";
            }
        }
        if (!this.current(context)) return;
        this.marks = marks;
        this.error = null;
        this.watch(context, cx);
      } catch (e) {
        if (this.current(context)) this.error = String(e);
      } finally {
        if (this.current(context)) {
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

  /** Reads the tree again now that this view changed it: at once, or once more after a read already under way. */
  reread(cx) {
    if (this.loading) this.stale = true;
    else this.refresh(cx);
  }

  toggle(path, cx) {
    if (this.folders.has(path)) {
      for (const folder of [...this.folders])
        if (folder === path || folder.startsWith(`${path}/`)) {
          this.folders.delete(folder);
          this.entries.delete(folder);
        }
    } else {
      this.folders.add(path);
      if (!this.entries.has(path) && !this.pending.has(path)) {
        const context = this.context;
        this.pending.add(path);
        cx.spawn(async (cx) => {
          try {
            await this.loadFolder(path, context);
          } catch (e) {
            if (this.current(context)) this.error = String(e);
          } finally {
            if (this.current(context)) this.pending.delete(path);
            cx.notify();
          }
        });
      }
    }
    cx.notify();
  }

  // -------------------------------------------------------------------------------------------------------------------
  // New, rename, delete, for files and folders. lh-files-ops.js runs them; this side asks first.

  /** Whether files and folders can be made, renamed and deleted in the folder in view. */
  ops() {
    return Boolean(this.context?.cwd) && canOperate(this.context.on);
  }

  /** An operation is under way: nothing else starts until it ends. */
  busy() {
    return Boolean(this.edit?.busy || this.ask?.busy);
  }

  /** The listed entry at `path` (from the folder in view), or null. */
  entry(path) {
    const at = path.lastIndexOf("/");
    return (this.entries.get(at < 0 ? "" : path.slice(0, at)) ?? []).find((e) => e.name === path.slice(at + 1)) ?? null;
  }

  /** The open file, when it is `path` and there. */
  docAt(path) {
    return this.doc && !this.doc.missing && this.doc.path === path ? this.doc : null;
  }

  /** Back to the tree for an action there; false while the open file's unsaved edits are asked about first. */
  leaveDoc(cx) {
    if (this.doc) this.back(cx);
    return !this.doc;
  }

  /** 새 파일, or 새 폴더 (`dir`): the name field as the first row of `folder` ("" the top level), the folder opened first. */
  startNew(folder, cx, dir = false) {
    if (!this.ops() || this.busy() || (folder && !this.entry(folder)?.dir) || !this.leaveDoc(cx)) return;
    if (folder && !this.folders.has(folder)) this.toggle(folder, cx);
    this.openField({ kind: "new", dir, where: "tree", folder }, "");
    cx.notify();
  }

  /** 이름 변경: the name field over a file's or folder's own name, on its row or, for the open file, in the header. */
  startRename(path, cx) {
    if (!this.ops() || this.busy()) return;
    const doc = this.docAt(path);
    const listed = this.entry(path);
    if (!doc && (!listed || !this.leaveDoc(cx))) return;
    const dir = !doc && listed.dir;
    const name = path.split("/").pop();
    // A file's name before its extension is selected: typing replaces that and keeps the extension. A folder's, whole.
    const dot = dir ? -1 : name.lastIndexOf(".");
    this.openField({ kind: "rename", dir, where: doc ? "head" : "tree", folder: path.slice(0, Math.max(0, path.lastIndexOf("/"))), path, name }, name, { start: 0, end: dot > 0 ? dot : name.length });
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

  /** Types into the open name field (`files:input:type:<name>`), as the keyboard does: tests drive it this way. */
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

  /**
   * ⏎ in the name field. A refused name stays in the field with why; the same name (a rename) closes it. A new file
   * opens in the editor once made; a renamed one that is open takes its edits along to the new name. A renamed folder
   * keeps what was open in it, under its new name.
   */
  submit(cx) {
    const e = this.edit;
    if (!e || e.busy) return;
    const context = this.context;
    const name = this.input.value();
    if (e.kind === "rename" && name === e.name) return this.cancelEdit(cx);
    e.error = invalidName(name, (this.entries.get(e.folder) ?? []).map((x) => x.name), e.kind === "rename" ? e.name : null);
    if (e.error) return cx.notify();
    const path = e.folder ? `${e.folder}/${name}` : name;
    const abs = `${context.cwd}/${path}`;
    const doc = e.kind === "rename" ? this.docAt(e.path) : null;
    e.busy = true;
    if (doc) doc.renaming = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const r =
        e.kind === "rename" ? await renameEntry(`${context.cwd}/${e.path}`, abs, context.on)
        : e.dir ? await createFolder(abs, context.on)
        : await createFile(abs, context.on);
      e.busy = false;
      if (doc) doc.renaming = false;
      if (r.ok && e.kind === "rename") {
        this.remember(context, e.path, path);
        if (e.dir && this.current(context)) this.retarget(e.path, path);
        if (doc && this.doc === doc) {
          doc.path = path;
          doc.abs = abs;
          doc.name = name;
          doc.disk = undefined;
          this.checkDisk(cx);
        }
      }
      if (this.current(context)) {
        // Taken after all (made since the tree was read): the field stays, with why.
        if (r.taken) e.error = "같은 이름이 이미 있습니다";
        else if (this.edit === e) {
          this.edit = null;
          this.handle.focus();
        }
        if (r.failed) this.failed = `${e.kind === "rename" ? "이름을 바꾸지 못했습니다" : e.dir ? "폴더를 만들지 못했습니다" : "파일을 만들지 못했습니다"} · ${r.failed}`;
        await this.loadFolder(e.folder, context).catch(() => {});
        this.reread(cx);
        if (r.ok && e.kind === "new" && !e.dir && this.current(context)) this.open(path, cx);
      }
      cx.notify();
    });
  }

  /**
   * 삭제: the confirm, never the deletion. Whether it goes to the Trash, and for a folder what it holds, are settled
   * before the confirm shows.
   */
  startDelete(path, cx) {
    if (!this.ops() || this.busy()) return;
    const doc = this.docAt(path);
    const listed = this.entry(path);
    if (!doc && (!listed || !this.leaveDoc(cx))) return;
    const dir = !doc && listed.dir;
    const context = this.context;
    const abs = `${context.cwd}/${path}`;
    if (!context.on && !this.trashCheck) this.trashCheck = trashes(null);
    cx.spawn(async (cx) => {
      const [trash, contents] = await Promise.all([context.on ? false : this.trashCheck, dir ? folderContents(abs, context.on) : null]);
      if (!this.current(context) || this.busy()) return;
      this.edit = null;
      this.failed = null;
      this.confirm = false;
      this.ask = { path, abs, on: context.on, trash, dir, contents, busy: false };
      this.handle.focus();
      cx.notify();
    });
  }

  cancelDelete(cx) {
    if (!this.ask || this.ask.busy) return;
    this.ask = null;
    cx.notify();
  }

  /** The confirm's own button: deletes the file or folder it names (and closes the editor on what goes with it). */
  confirmDelete(cx) {
    const a = this.ask;
    if (!a || a.busy) return;
    const context = this.context;
    a.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = a.dir ? await deleteFolder(a.abs, a.on, a.trash) : await deleteFile(a.abs, a.on, a.trash);
      if (this.ask === a) this.ask = null;
      if (r.ok) {
        this.remember(context, a.path, null);
        if (a.dir && this.current(context)) this.retarget(a.path, null);
        if (this.doc && this.doc.on === a.on && (this.doc.abs === a.abs || this.doc.abs.startsWith(`${a.abs}/`))) this.setDoc(null);
      } else if (this.current(context)) {
        const why = r.folder ? "폴더는 지우지 않습니다" : r.notFolder ? "폴더가 아닙니다" : r.failed;
        this.failed = `${a.trash ? "휴지통으로 옮기지 못했습니다" : "삭제하지 못했습니다"} · ${why}`;
      }
      if (this.current(context)) {
        await this.loadFolder(a.path.slice(0, Math.max(0, a.path.lastIndexOf("/"))), context).catch(() => {});
        this.reread(cx);
      }
      cx.notify();
    });
  }

  /**
   * Other spaces on this folder remember their open file and open folders by path: they follow a rename (`to`), a
   * delete forgets them. `from` may be a folder: everything under it moves or goes with it.
   */
  remember(context, from, to) {
    for (const [key, s] of this.saved) {
      const at = JSON.parse(key);
      if (at.cwd !== context.cwd || (at.on ?? null) !== (context.on ?? null)) continue;
      if (s.file) s.file = moved(s.file, from, to);
      s.folders = new Set([...(s.folders ?? [])].map((p) => moved(p, from, to)).filter(Boolean));
    }
  }

  /** The folder in view after a folder `from` was renamed to `to` (or deleted: null): what was open in it follows. */
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

  /**
   * `lstack-herdr-cockpit.files:new` (새 파일, the top level), `.files:new:<folder>` (이 폴더에 새 파일),
   * `.files:mkdir` (새 폴더, the top level), `.files:mkdir:<folder>` (이 폴더에 새 폴더), `.files:rename:<path>`
   * (이름 변경, a file or folder), `.files:delete:<path>` (삭제: its confirm only), `.files:input:type:<name>`,
   * `.files:input:submit` and `.files:input:cancel` (the name field's ⏎ and esc), `.files:confirm:delete` and
   * `.files:confirm:cancel` (the confirm's buttons); paths from the folder in view. Palette, keys and `herdr-app do`
   * reach the panel's copy while it is drawn.
   */
  command(c, cx) {
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
    else return;
    cx.notify();
  }

  // -------------------------------------------------------------------------------------------------------------------
  // The open file

  setDoc(doc) {
    this.doc?.state?.release();
    this.doc = doc;
    this.confirm = false;
    this.held = null;
    // The name field belongs to where it opened: the header's goes with its file, the tree's once a file opens.
    if (this.edit && (doc || this.edit.where === "head")) this.edit = null;
  }

  /** Opens a file of the folder in view (its path from that folder). */
  open(path, cx) {
    const { cwd, on } = this.context;
    // disk: what the file holds now when that is not what was read (a text, or null once it is gone).
    const doc = { path, name: path.split("/").pop(), abs: `${cwd}/${path}`, on, state: null, original: null, big: false, locked: null, dirty: false, saving: false, disk: undefined, failed: null, error: null };
    this.setDoc(doc);
    cx.spawn(async (cx) => {
      try {
        // Herdr replaces a file whole, which a read-only one would not stop: its permission is asked for here.
        const [text, writable] = await Promise.all([readTextFile(doc.abs, { on }), on ? false : exec("test", ["-w", doc.abs]).then((r) => r.code === 0, () => true)]);
        if (this.doc !== doc) return;
        if (text === null) {
          doc.missing = true;
          doc.error = "파일이 없습니다";
        } else if (text.includes("\0")) doc.error = "바이너리 파일입니다 · 텍스트로 열 수 없습니다";
        else {
          doc.locked = on ? "원격 스페이스" : writable ? null : "쓰기 권한 없음";
          this.fill(doc, text);
        }
      } catch (e) {
        if (this.doc === doc) doc.error = unreadable(e);
      } finally {
        cx.notify();
      }
    });
  }

  /** Shows `text` as what the disk holds: a new buffer the first time, the same one after (its edits are replaced). */
  fill(doc, text) {
    const big = text.length > MAX_EDIT;
    const shown = big ? `${text.slice(0, MAX_EDIT)}\n… (여기까지만 표시합니다)` : text;
    if (doc.state && doc.big === big) doc.state.set_value(shown);
    else {
      doc.state?.release();
      const lang = language(doc.name);
      doc.state = EditorState.new({ language: lang, value: shown, readonly: Boolean(doc.locked) || big, soft_wrap: PROSE.has(lang), font_family: settings().font_family, font_size: 13, syntax: palette(lang) });
      doc.state.on("change", (_e, cx) => this.changed(doc, cx));
    }
    doc.big = big;
    doc.original = text;
    doc.dirty = false;
    doc.disk = undefined;
    doc.failed = null;
  }

  editable(doc) {
    return Boolean(doc?.state) && !doc.locked && !doc.big;
  }

  /**
   * Whether the buffer holds edits the disk does not, asked of the buffer itself. The Editor's change event keeps
   * `dirty` (the dot, 저장) current as the person types; whatever could lose edits asks here instead of trusting it.
   */
  unsaved(doc) {
    if (!this.editable(doc)) return false;
    doc.dirty = doc.state.value() !== doc.original;
    return doc.dirty;
  }

  /** The person typed. */
  changed(doc, cx) {
    const was = doc.dirty;
    if (this.unsaved(doc) !== was) cx.notify();
  }

  /** Reads the open file again: reloaded when there are no edits to lose, else what is there now waits in the notice. */
  checkDisk(cx) {
    const doc = this.doc;
    if (!doc?.state || doc.on) return;
    if (doc.checking) {
      doc.again = true;
      return;
    }
    doc.checking = true;
    cx.spawn(async (cx) => {
      try {
        do {
          doc.again = false;
          const text = await readTextFile(doc.abs).catch(() => undefined);
          if (this.doc !== doc) return;
          // Unreadable just now, or being written or renamed by this view: the next change says more.
          if (text === undefined || doc.saving || doc.renaming) continue;
          const before = [doc.disk, doc.original, doc.dirty];
          if (text === doc.original) doc.disk = undefined;
          else if (text !== null && !this.unsaved(doc)) this.fill(doc, text);
          else doc.disk = text;
          if (doc.disk !== before[0] || doc.original !== before[1] || doc.dirty !== before[2]) cx.notify();
        } while (doc.again);
      } finally {
        doc.checking = false;
      }
    });
  }

  save(cx) {
    const doc = this.doc;
    if (!this.editable(doc) || doc.saving || doc.renaming || doc.disk !== undefined) return;
    const text = doc.state.value();
    if (text !== doc.original) this.write(doc, text, doc.original, cx);
  }

  /** Keeps the person's text over what the disk holds now (the notice's 덮어쓰기, or 다시 저장 for a file that is gone). */
  overwrite(cx) {
    const doc = this.doc;
    if (!this.editable(doc) || doc.saving || doc.renaming || doc.disk === undefined) return;
    this.write(doc, doc.state.value(), doc.disk, cx);
  }

  /** Takes what the disk holds now, dropping the person's edits (the notice's 다시 불러오기). */
  reload(cx) {
    const doc = this.doc;
    if (!doc?.state || typeof doc.disk !== "string") return;
    this.fill(doc, doc.disk);
    cx.notify();
  }

  /** Writes `text` over `expected`, what the disk is known to hold (null: nothing there). */
  write(doc, text, expected, cx) {
    doc.saving = true;
    doc.failed = null;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await writeTextFile(doc.abs, text, expected);
        doc.original = text;
        doc.disk = undefined;
        if (this.doc === doc) doc.dirty = doc.state.value() !== text;
      } catch (e) {
        // Refused: either the disk no longer holds `expected` (that notice takes over), or the write itself failed.
        const now = await readTextFile(doc.abs).catch(() => undefined);
        if (now !== undefined && now !== expected) doc.disk = now;
        else doc.failed = said(e);
      } finally {
        doc.saving = false;
        cx.notify();
      }
    });
  }

  /** Back to the tree; with unsaved edits, only after the person says to drop them. */
  back(cx) {
    if (this.doc?.saving || this.doc?.renaming) return;
    if (this.unsaved(this.doc)) this.confirm = true;
    else this.setDoc(null);
    cx.notify();
  }

  discard(cx) {
    this.setDoc(null);
    cx.notify();
  }

  /** `typed`: pressed in the panel; a key driven by `lstack-herdr-cockpit.key:<keystroke>` is not. */
  key(e, cx, typed = false) {
    const k = e.keystroke;
    // The delete confirm's default is 취소: esc, and ⏎ where the panel has the keyboard (or driven), cancel it.
    if (this.ask && (k === "escape" || (k === "enter" && (!typed || this.handle.is_focused())))) return this.cancelDelete(cx), true;
    if (this.edit && k === "escape") return this.cancelEdit(cx), true;
    // A ⏎ typed in the name field is its submit; only a driven one comes here.
    if (this.edit && k === "enter" && !typed) return this.submit(cx), true;
    if ((k === "cmd-s" || k === "ctrl-s") && this.doc) return this.save(cx), true;
    if (k === "escape" && this.confirm) return (this.confirm = false), cx.notify(), true;
    return false;
  }

  // -------------------------------------------------------------------------------------------------------------------
  // Drawing

  render(cx) {
    if (this.follow(cx)) this.refresh(cx);
    const k = tokens();
    const doc = this.doc;
    // Saved or typed back to the disk's text meanwhile: nothing is left to ask about.
    if (this.confirm && !doc?.dirty) this.confirm = false;
    const narrow = this.width < 340;
    let root = v_flex()
      .id("lh-files")
      .size_full()
      .min_h(0)
      .relative()
      .bg(k.background)
      .text_color(k.foreground)
      .text_size(TEXT.base)
      .on_size_change((size, cx) => {
        const z = settings().zoom ?? 1;
        if (Math.abs(size.width / z - this.width) < 1) return;
        this.width = size.width / z;
        cx.notify();
      })
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (this.key(e, cx, true)) cx.stop_propagation();
      })
      .child(doc ? this.fileHead(k, doc, narrow) : this.treeHead(k, narrow));
    if (this.ask) root = root.child(this.askNotice(k, narrow));
    else if (doc && this.confirm)
      root = root.child(
        this.notice(k, "lh-files-confirm", k.warning, "저장하지 않은 변경을 버릴까요?", [
          Button("lh-files-keep", { label: "취소", variant: "outline", size: "sm", kbd: narrow ? undefined : "esc", onClick: (_e, cx) => ((this.confirm = false), cx.notify()) }),
          Button("lh-files-discard", { label: "버리기", variant: "destructive", size: "sm", onClick: (_e, cx) => this.discard(cx) }),
        ]),
      );
    else if (doc?.state && doc.disk !== undefined)
      root = root.child(
        this.notice(
          k,
          "lh-files-disk",
          k.warning,
          doc.disk === null ? "디스크에서 파일이 삭제되었습니다" : "디스크에서 파일이 바뀌었습니다",
          [
            typeof doc.disk === "string" && Button("lh-files-reload", { label: "다시 불러오기", variant: "outline", size: "sm", tooltip: "디스크의 내용으로 바꿉니다 · 여기서 고친 내용은 사라집니다", onClick: (_e, cx) => this.reload(cx) }),
            this.editable(doc) && Button("lh-files-overwrite", { label: doc.disk === null ? "다시 저장" : "덮어쓰기", variant: "outline", size: "sm", disabled: doc.saving, tooltip: "여기 있는 내용으로 저장합니다", onClick: (_e, cx) => this.overwrite(cx) }),
          ].filter(Boolean),
        ),
      );
    else if (doc?.failed) root = root.child(this.notice(k, "lh-files-failed", k.destructive, `저장하지 못했습니다 · ${doc.failed}`, []));
    else if (this.failed)
      root = root.child(
        this.notice(k, "lh-files-op-failed", k.destructive, this.failed, [
          Button("lh-files-op-failed-close", { icon: "x", variant: "ghost", size: "icon-sm", tooltip: "알림 닫기", onClick: (_e, cx) => ((this.failed = null), cx.notify()) }),
        ]),
      );
    return root.child(doc ? this.fileBody(k, doc) : this.tree(k));
  }

  /**
   * The delete confirm: the path, where it goes (the Trash, or gone for good), what else goes with it: a folder's
   * entries (or, for a link to a folder, that its target stays), an open file's unsaved edits.
   */
  askNotice(k, narrow) {
    const a = this.ask;
    const doc = this.doc?.abs === a.abs && this.doc.on === a.on ? this.doc : null;
    const c = a.contents;
    const what = !a.dir ? "파일을" : c?.link ? "링크를" : "폴더를";
    const goes = a.trash ? "휴지통으로 갑니다" : "지워집니다";
    const inside =
      !a.dir ? null
      : c?.link ? "폴더를 가리키는 링크입니다 · 링크만 지우고 가리키는 폴더는 그대로 둡니다"
      : !c ? `안에 든 항목 수를 세지 못했습니다 · 모두 함께 ${goes}`
      : c.more ? `안에 든 항목 ${thousands(c.count)}개 이상도 함께 ${goes}`
      : c.count ? `안에 든 항목 ${thousands(c.count)}개도 함께 ${goes}`
      : "빈 폴더입니다";
    const body = v_flex()
      .gap(2)
      .child(div().font_semibold().child(a.trash ? `이 ${what} 휴지통으로 이동할까요?` : `이 ${what} 영구 삭제할까요?`))
      .child(Mono(a.dir ? `${a.path}/` : a.path, { size: TEXT.sm, color: k.foreground }))
      .when(Boolean(inside), (e) => e.child(div().text_color(c?.count || c?.more || !c ? k.destructive : k.mutedFg).child(inside)))
      .child(div().text_color(k.mutedFg).child(a.trash ? "휴지통에서 되살릴 수 있습니다" : a.on ? `${a.on}에서 지웁니다 · 되돌릴 수 없습니다` : "되돌릴 수 없습니다"))
      .when(this.unsaved(doc), (e) => e.child(div().text_color(k.destructive).child("편집기에서 저장하지 않은 변경도 함께 사라집니다")));
    return this.notice(k, "lh-files-ask", k.destructive, body, [
      Button("lh-files-ask-cancel", { label: "취소", variant: "outline", size: "sm", kbd: narrow ? undefined : "esc", disabled: a.busy, tooltip: "지우지 않습니다  ⏎ · esc", onClick: (_e, cx) => this.cancelDelete(cx) }),
      Button("lh-files-ask-delete", {
        label: a.busy ? "지우는 중…" : a.trash ? "휴지통으로 이동" : "영구 삭제",
        icon: "trash",
        variant: "destructive",
        size: "sm",
        disabled: a.busy,
        tooltip: a.trash ? `이 ${what} 휴지통으로 옮깁니다` : `이 ${what} 되돌릴 수 없게 지웁니다`,
        onClick: (_e, cx) => this.confirmDelete(cx),
      }),
    ]);
  }

  notice(k, id, tone, text, actions) {
    return h_flex()
      .id(id)
      .flex_none()
      .flex_wrap()
      .px(12)
      .py(8)
      .gap(8)
      .items_center()
      .border_b_1()
      .border_color(k.border)
      .bg(alpha(tone, 0.1))
      .child(Icon("triangle-alert", { size: 14, color: tone }))
      .child(div().flex_1().min_w(140).text_size(TEXT.sm).child(text))
      .children(actions);
  }

  treeHead(k, narrow) {
    const { cwd, on } = this.context ?? {};
    return h_flex()
      .h(44)
      .flex_none()
      .px(12)
      .gap(8)
      .items_center()
      .border_b_1()
      .border_color(k.border)
      .child(h_flex().size(24).flex_none().rounded(RADIUS.md).items_center().justify_center().bg(alpha(k.ring, 0.14)).child(Icon("folder", { size: 14, color: k.ring })))
      .child(
        v_flex()
          .flex_1()
          .min_w(0)
          .child(div().truncate().text_size(TEXT.base).font_semibold().child("Files"))
          .child(div().truncate().text_size(TEXT.xs).text_color(k.mutedFg).child(cwd ? [tilde(cwd), on].filter(Boolean).join(" · ") : "폴더 없음")),
      )
      .when(this.ops(), (e) =>
        e
          .child(
            Button("lh-files-new", {
              label: narrow ? undefined : "새 파일",
              icon: "file-plus",
              variant: "outline",
              size: narrow ? "icon-sm" : "sm",
              disabled: this.busy(),
              tooltip: "이 폴더의 맨 위에 새 파일을 만듭니다",
              onClick: (_e, cx) => this.startNew("", cx),
            }),
          )
          .child(
            Button("lh-files-mkdir", {
              label: narrow ? undefined : "새 폴더",
              icon: "folder-plus",
              variant: "outline",
              size: narrow ? "icon-sm" : "sm",
              disabled: this.busy(),
              tooltip: "이 폴더의 맨 위에 새 폴더를 만듭니다",
              onClick: (_e, cx) => this.startNew("", cx, true),
            }),
          ),
      );
  }

  fileHead(k, doc, narrow) {
    const root = this.context.cwd.split(/[\\/]/).pop();
    const where = doc.path.includes("/") ? `${root}/${doc.path.slice(0, doc.path.lastIndexOf("/"))}` : root;
    const locked = doc.locked ?? (doc.big ? "큰 파일" : null);
    const can = this.editable(doc);
    const naming = this.edit?.where === "head" ? this.edit : null;
    const acts = this.ops() && !naming && !doc.missing && doc.disk !== null;
    let head = h_flex()
      .flex_none()
      .pl(6)
      .pr(10)
      .gap(6)
      .items_center()
      .border_b_1()
      .border_color(k.border);
    head = naming ? head.min_h(44).py(6) : head.h(44);
    return head
      .child(Button("lh-files-back", { icon: "chevron-left", variant: "ghost", size: "icon-sm", tooltip: "파일 목록으로", onClick: (_e, cx) => this.back(cx) }))
      .child(
        naming
          ? this.field(k, naming)
          : v_flex()
              .flex_1()
              .min_w(0)
              .child(
                h_flex()
                  .gap(6)
                  .items_center()
                  .child(div().flex_shrink_1().min_w(0).truncate().text_size(TEXT.base).font_semibold().child(doc.name))
                  .when(doc.dirty, (e) => e.child(div().id("lh-files-dirty").size(7).flex_none().rounded_full().bg(k.foreground).tooltip("저장하지 않은 변경"))),
              )
              .child(div().truncate().text_size(TEXT.xs).text_color(k.mutedFg).child([where, locked && `읽기 전용 · ${locked}`].filter(Boolean).join(" · "))),
      )
      .when(acts, (e) =>
        e
          .child(Button("lh-files-rename", { icon: "pencil", variant: "ghost", size: "icon-sm", disabled: doc.saving, tooltip: "이름 변경", onClick: (_e, cx) => this.startRename(doc.path, cx) }))
          .child(Button("lh-files-delete", { icon: "trash", variant: "ghost", size: "icon-sm", disabled: doc.saving, tooltip: "삭제…", onClick: (_e, cx) => this.startDelete(doc.path, cx) })),
      )
      .when(can, (e) =>
        e.child(
          Button("lh-files-save", {
            label: narrow ? undefined : doc.saving ? "저장 중…" : "저장",
            icon: "check",
            variant: doc.dirty ? "default" : "outline",
            size: narrow ? "icon-sm" : "sm",
            kbd: narrow ? undefined : "⌘S",
            disabled: !doc.dirty || doc.saving || doc.disk !== undefined,
            tooltip: "저장  ⌘S",
            onClick: (_e, cx) => this.save(cx),
          }),
        ),
      );
  }

  fileBody(k, doc) {
    if (doc.state) return Editor.new(doc.state).flex_1().min_h(0);
    return div().p(12).text_size(TEXT.sm).text_color(k.dim).child(doc.error ?? "파일을 여는 중…");
  }

  /** The name field: the name, ⏎ and esc (their buttons beside it), and under it the keys or why a name was refused. */
  field(k, e) {
    const verb = e.kind === "rename" ? "이름 바꾸기" : e.dir ? "폴더 만들기" : "만들기";
    const doing = e.kind === "rename" ? "이름을 바꾸는 중…" : e.dir ? "폴더를 만드는 중…" : "만드는 중…";
    const hint = e.error ?? (e.busy ? doing : `⏎ ${verb} · esc 취소`);
    return v_flex()
      .flex_1()
      .min_w(0)
      .gap(3)
      .child(
        h_flex()
          .gap(2)
          .items_center()
          .child(TextField(this.input))
          .child(Button("lh-files-field-ok", { icon: "check", variant: "ghost", size: "icon-sm", disabled: e.busy, tooltip: `${verb}  ⏎`, onClick: (_e, cx) => this.submit(cx) }))
          .child(Button("lh-files-field-cancel", { icon: "x", variant: "ghost", size: "icon-sm", disabled: e.busy, tooltip: "취소  esc", onClick: (_e, cx) => this.cancelEdit(cx) })),
      )
      .child(
        h_flex()
          .gap(4)
          .items_center()
          .text_size(TEXT.xs)
          .text_color(e.error ? k.destructive : k.dim)
          .when(Boolean(e.error), (x) => x.child(Icon("circle-x", { size: 12, color: k.destructive })))
          .child(div().min_w(0).child(hint)),
      );
  }

  /** The name field in the tree: a new entry's first row in its folder, or a renamed one's own row, its icon in line. */
  fieldRow(k, depth) {
    const e = this.edit;
    const icon = e.kind === "new" ? (e.dir ? "folder-plus" : "file-plus") : e.dir ? "folder" : "file-text";
    return h_flex()
      .id("lh-files-field")
      .flex_none()
      .py(3)
      .pl(8 + depth * 18 + 19)
      .pr(2)
      .gap(7)
      .items_start()
      .child(h_flex().h(32).flex_none().items_center().child(Icon(icon, { size: 14, color: k.mutedFg })))
      .child(this.field(k, this.edit));
  }

  tree(k) {
    const rows = this.rows("", 0, [], k);
    const idle = this.error || (this.loading ? "파일 목록을 읽는 중…" : this.context?.cwd ? "파일이 없습니다" : "폴더가 없습니다");
    const naming = this.edit?.where === "tree" && this.edit.folder === "";
    return v_flex()
      .id("lh-files-tree")
      .flex_1()
      .min_h(0)
      .overflow_y_scrollbar()
      .p(6)
      .children(rows)
      .when(Boolean(this.error) || (!naming && !this.entries.get("")?.length), (e) => e.child(div().p(8).text_size(TEXT.sm).text_color(k.dim).child(idle)))
      .when(Boolean(this.limited), (e) => e.child(div().p(8).text_size(TEXT.xs).text_color(k.dim).child("폴더당 500개 · 전체 5,000개까지만 표시합니다")));
  }

  /**
   * A row's actions, each stopping its click there: 이 폴더에 새 파일 and 새 폴더 on a folder, then 이름 변경 and 삭제 on
   * every row.
   */
  rowActions(entry, path) {
    const act = (id, icon, tooltip, run) =>
      Button(id, {
        icon,
        variant: "ghost",
        size: "icon-sm",
        tooltip,
        onClick: (_e, cx) => {
          cx.stop_propagation();
          run(cx);
        },
      });
    const inside = entry.dir
      ? [act(`lh-file-new-${path}`, "file-plus", "이 폴더에 새 파일", (cx) => this.startNew(path, cx)), act(`lh-file-mkdir-${path}`, "folder-plus", "이 폴더에 새 폴더", (cx) => this.startNew(path, cx, true))]
      : [];
    return [...inside, act(`lh-file-rename-${path}`, "pencil", "이름 변경", (cx) => this.startRename(path, cx)), act(`lh-file-delete-${path}`, "trash", entry.dir ? "폴더 삭제…" : "삭제…", (cx) => this.startDelete(path, cx))];
  }

  rows(prefix, depth, out, k) {
    if (out.length >= TOTAL || depth > 40) return out;
    const edit = this.edit?.where === "tree" ? this.edit : null;
    if (edit?.kind === "new" && edit.folder === prefix) out.push(this.fieldRow(k, depth));
    for (const entry of this.entries.get(prefix) ?? []) {
      if (out.length >= TOTAL) break;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (edit?.kind === "rename" && edit.path === path) {
        out.push(this.fieldRow(k, depth));
        // A folder being renamed keeps what is open under it in view.
        if (entry.dir && this.folders.has(path)) this.rows(path, depth + 1, out, k);
        continue;
      }
      const open = this.folders.has(path);
      const mark = this.marks[`${this.context.cwd}/${path}`];
      const id = `lh-file-${path}`;
      // Shown while the pointer is on the row, and on the row a delete confirm names.
      const asked = this.ask?.path === path;
      const actions = this.ops() && !this.busy() && (asked || this.hover.is(id)) ? this.rowActions(entry, path) : null;
      const row = h_flex()
        .id(id)
        .h(28)
        .flex_none()
        .pl(8 + depth * 18)
        .pr(8)
        .gap(7)
        .items_center()
        .rounded(RADIUS.md)
        .cursor_pointer()
        .when(asked, (e) => e.bg(alpha(k.destructive, 0.12)))
        .hover((s) => s.bg(k.accent))
        .on_click((_e, cx) => {
          if (entry.dir) this.toggle(path, cx);
          else {
            this.open(path, cx);
            cx.notify();
          }
        })
        .child(entry.dir ? Icon(open ? "chevron-down" : "chevron-right", { size: 12, color: k.dim }) : div().w(12).flex_none())
        .child(Icon(entry.dir ? "folder" : "file-text", { size: 14, color: k.mutedFg }))
        .child(div().flex_1().min_w(0).truncate().child(entry.name))
        .when(Boolean(actions), (e) => e.child(h_flex().flex_none().children(actions)))
        .when(Boolean(mark), (e) => e.child(div().flex_none().text_size(TEXT.xs).text_color(mark === "A" ? k.success : mark === "D" || mark === "U" ? k.destructive : k.blocked).child(mark)));
      out.push(this.hover.track(row, id));
      if (entry.dir && open) this.rows(path, depth + 1, out, k);
    }
    return out;
  }
}
