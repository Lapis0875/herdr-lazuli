// File kinds and the modes each one offers (DESIGN B3, B10), path normalization and the dedupe key of
// a file tab, tab names with their markers, name rules for new files, and the read-only rules (B4).
// Pure: no herdr imports.

/** Over this many characters a file opens read-only, cut to this length (B4). */
export const MAX_EDIT = 400000;

/** Mode order for cycling (⌘⇧V): Edit → Split → Preview → Edit. */
const ORDER = ["edit", "split", "preview"];

const KIND_BY_EXT = {
  md: "md",
  markdown: "md",
  html: "html",
  htm: "html",
  pdf: "pdf",
  svg: "svg",
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
};

const MODES = {
  md: ["edit", "split", "preview"],
  html: ["edit", "split", "preview"],
  svg: ["edit", "split", "preview"],
  pdf: ["preview"],
  image: ["preview"],
  text: ["edit"],
};

const REMOTE_MODES = {
  md: ["edit", "split", "preview"],
  html: ["edit"],
  svg: ["edit"],
  pdf: [],
  image: [],
  text: ["edit"],
};

const DEFAULT_MODE = { md: "split", html: "preview", pdf: "preview", svg: "split", image: "preview", text: "edit" };

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const str = (v) => (typeof v === "string" ? v : "");

/** The kind of a file by its extension, case-insensitive: md, html, pdf, svg, image, or text for
 *  anything else (a name without an extension, a dot file, `a.tar.gz`). */
export function kindOf(name) {
  const base = basename(str(name));
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return "text";
  const ext = base.slice(dot + 1).toLowerCase();
  return own(KIND_BY_EXT, ext) ? KIND_BY_EXT[ext] : "text";
}

/** The modes a kind offers, in cycling order. Remote files: md and text keep theirs, html and svg
 *  are edit only, pdf and image none (the info card). An unknown kind has none. */
export function modesFor(kind, o) {
  const table = o?.remote ? REMOTE_MODES : MODES;
  return own(table, kind) ? [...table[kind]] : [];
}

/** The mode a kind opens in (B3), or its first available mode when that one is not offered; null
 *  when it offers none. */
export function defaultMode(kind, o) {
  const modes = modesFor(kind, o);
  if (!modes.length) return null;
  const mode = own(DEFAULT_MODE, kind) ? DEFAULT_MODE[kind] : null;
  return modes.includes(mode) ? mode : modes[0];
}

/** The mode after `mode`: Edit → Split → Preview → Edit, skipping modes the kind does not offer.
 *  A mode the kind does not offer gives its default; no modes gives null. */
export function nextMode(kind, mode, o) {
  const modes = modesFor(kind, o);
  if (!modes.length) return null;
  const at = ORDER.indexOf(mode);
  if (at < 0 || !modes.includes(mode)) return defaultMode(kind, o);
  for (let i = 1; i <= ORDER.length; i++) {
    const next = ORDER[(at + i) % ORDER.length];
    if (modes.includes(next)) return next;
  }
  return mode;
}

/** A path with "." and ".." resolved and "//" collapsed, without a trailing "/" ("/" stays "/").
 *  ".." above the root stays at the root; a relative path keeps its leading "..". An empty
 *  relative result is ".". */
export function normalize(path) {
  const p = str(path);
  if (p === "") return "";
  const absolute = p.startsWith("/");
  const out = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(part);
  }
  if (absolute) return `/${out.join("/")}`;
  return out.length ? out.join("/") : ".";
}

/** The dedupe key of a file tab: its machine (empty for this one), ":", the normalized path. */
export function fileKey(file, on) {
  return `${typeof on === "string" ? on : ""}:${normalize(file)}`;
}

/** The last part of a path ("" for "/"). */
export function basename(path) {
  const p = str(path).replace(/\/+$/, "");
  return p.slice(p.lastIndexOf("/") + 1);
}

/** The folder of a path: "/a/b" → "/a", "/a" → "/", "a" → ".". */
export function dirname(path) {
  const p = str(path).replace(/\/+$/, "");
  const at = p.lastIndexOf("/");
  if (at < 0) return str(path).startsWith("/") ? "/" : ".";
  if (at === 0) return "/";
  return p.slice(0, at);
}

/** The path with the home folder written as "~". */
export function tilde(path, home) {
  const p = str(path);
  const h = normalize(str(home));
  if (!h || h === "/" || h === ".") return p;
  if (p === h) return "~";
  return p.startsWith(`${h}/`) ? `~${p.slice(h.length)}` : p;
}

/** A file tab's name (B2, D3): the file name, with "● " while it has unsaved edits, else "◦ " while it
 *  is a preview tab. */
export function tabName(file, o) {
  const base = basename(file);
  if (o?.dirty) return `● ${base}`;
  if (o?.preview) return `◦ ${base}`;
  return base;
}

/** Why a new file or folder name is refused, or null when it is fine: empty (blank), dots ("." or
 *  ".."), slash (contains "/"), taken (a sibling has it). */
export function invalidName(name, siblings) {
  const n = str(name);
  if (n.trim() === "") return "empty";
  if (n === "." || n === "..") return "dots";
  if (n.includes("/")) return "slash";
  if (Array.isArray(siblings) && siblings.includes(n)) return "taken";
  return null;
}

/** Whether a text opens read-only, why (the first of remote, too-large, nul, not-writable), and the
 *  text to show: cut to MAX_EDIT characters when longer. */
export function editability(o) {
  const text = str(o?.text);
  const remote = typeof o?.on === "string" && o.on !== "";
  const large = text.length > MAX_EDIT;
  let reason = null;
  if (remote) reason = "remote";
  else if (large) reason = "too-large";
  else if (text.includes("\0")) reason = "nul";
  else if (o?.writable === false) reason = "not-writable";
  return { readOnly: reason !== null, reason, text: large ? text.slice(0, MAX_EDIT) : text };
}
