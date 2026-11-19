// Unsaved drafts (DESIGN B5): the buffer of a dirty file tab, kept under data/lazuli/drafts/ every
// second, and what reopening the file does with one (recover banner, or drop it). Pure: the hashes
// (sha1 of the file key and of the disk text) and the time are arguments.

import { fileKey } from "./paths.js";

/** At most one draft write per this many ms. */
export const DRAFT_EVERY_MS = 1000;

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** The draft file of a file: `<dir>/<keyHash>.json`, keyHash = sha1 of its fileKey. */
export function draftFile(dir, keyHash) {
  return `${dir}/${keyHash}.json`;
}

/** A draft: `{version: 1, file, on, baseHash, text, at}`. `baseHash` is the hash of the disk text the
 *  edits started from. */
export function makeDraft(o) {
  return { version: 1, file: o.file, on: o.on ?? null, baseHash: o.baseHash ?? null, text: o.text, at: o.now };
}

/** A draft file's JSON → the draft, or null when it is absent, not JSON or not a version-1 draft. */
export function parseDraft(json) {
  if (typeof json !== "string") return null;
  let d;
  try {
    d = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isPlain(d) || d.version !== 1 || typeof d.file !== "string" || typeof d.text !== "string") return null;
  if (d.on !== null && d.on !== undefined && typeof d.on !== "string") return null;
  if (d.baseHash !== null && d.baseHash !== undefined && typeof d.baseHash !== "string") return null;
  return { version: 1, file: d.file, on: d.on ?? null, baseHash: d.baseHash ?? null, text: d.text, at: typeof d.at === "number" ? d.at : 0 };
}

/** Whether to write a draft now: the buffer is dirty, differs from the last draft written, and the
 *  last write is at least DRAFT_EVERY_MS old. */
export function shouldWrite(o) {
  return o.dirty === true && o.text !== o.lastText && o.now - o.lastAt >= DRAFT_EVERY_MS;
}

/** What opening a file does with its draft: no draft, or one for another file → nothing; the same
 *  text as the disk → remove it; otherwise the recover banner, with `baseChanged` when the disk
 *  changed since the edits started. */
export function decide(draft, disk) {
  const none = { banner: false, remove: false, baseChanged: false };
  if (!isPlain(draft) || !isPlain(disk)) return none;
  if (fileKey(draft.file, draft.on) !== fileKey(disk.file, disk.on)) return none;
  if (draft.text === disk.text) return { banner: false, remove: true, baseChanged: false };
  return { banner: true, remove: false, baseChanged: draft.baseHash !== disk.hash };
}
