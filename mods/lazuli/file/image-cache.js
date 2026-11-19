// The picture cache (ARCHITECTURE §6): image() draws only files inside the app home, and a file
// rewritten in place under data/ stays stale (spike S3), so every picture a file tab shows (a Markdown
// image, an image file, an SVG buffer) is copied to data/lazuli/cache/img/<sha1 of content>.<ext>: a
// new name per content, never written twice. At most 20 MB each and 200 MB in all, least recently used
// first (core/lru.js). Shared by every copy (module state, F3).

import * as fs from "fs/promises";
import { appHome, exec } from "herdr";
import { dataDir } from "../sys/store.js";
import { sha1 } from "../sys/filetabs.js";
import { basename } from "../core/paths.js";
import { evict } from "../core/lru.js";

const log = (msg) => console.log(`[lazuli/img] ${msg}`);
const errText = (e) => e?.message ?? String(e);

/** One cached picture at most. */
export const IMAGE_MAX = 20 * 1024 * 1024;
/** The cache at most. */
export const IMAGE_CAP = 200 * 1024 * 1024;
/** A source picture is looked at again after this long. */
export const IMAGE_TTL_MS = 60000;

const EXT = { png: "png", jpg: "jpg", jpeg: "jpg", gif: "gif", webp: "webp", svg: "svg" };

/** `<app home>/data/lazuli/cache/img`. */
export const imageDir = () => `${dataDir()}/cache/img`;
const indexPath = () => `${dataDir()}/cache/img.json`;
/** A path under the app home as image() takes it. */
const fromHome = (abs) => (abs.startsWith(`${appHome()}/`) ? abs.slice(appHome().length + 1) : abs);

function utf8Length(text) {
  let n = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
  }
  return n;
}

// name → {size, used}, persisted in cache/img.json and rebuilt from the folder on first use.
const entries = new Map();
let ready = null;

function load() {
  if (!ready) {
    ready = (async () => {
      let saved = {};
      try {
        if (await fs.exists(indexPath())) saved = JSON.parse(await fs.readFile(indexPath(), "utf8")) ?? {};
      } catch {
        saved = {};
      }
      const list = 'cd "$1" 2>/dev/null || exit 0; for f in *.*; do [ -f "$f" ] && printf "%s\\t%s\\n" "$(wc -c < "$f" | tr -d " ")" "$f"; done; exit 0';
      const r = await exec("sh", ["-c", list, "lazuli", imageDir()]).catch(() => ({ stdout: "" }));
      for (const line of r.stdout.split("\n")) {
        const [size, name] = line.split("\t");
        if (name) entries.set(name, { size: Number(size) || 0, used: typeof saved[name]?.used === "number" ? saved[name].used : 0 });
      }
    })();
  }
  return ready;
}

function touch(name) {
  const e = entries.get(name);
  if (e) e.used = Date.now();
}

async function admit(name, size) {
  entries.set(name, { size, used: Date.now() });
  const gone = evict([...entries].map(([n, e]) => ({ name: n, size: e.size, used: e.used })), IMAGE_CAP);
  for (const n of gone) {
    entries.delete(n);
    for (const [k, v] of sources) if (v.name === n) sources.delete(k);
    await fs.unlink(`${imageDir()}/${n}`).catch(() => {});
  }
  const index = {};
  for (const [n, e] of entries) index[n] = e;
  await fs.writeFile(indexPath(), JSON.stringify(index)).catch((e) => log(`index not written: ${errText(e)}`));
}

// $1 source, $2 cache folder, $3 extension, $4 most bytes. The source is read once, into a private
// temp copy; the size and hash are of that copy, which is then published under its hash with a rename
// (never seen half written; a source replaced meanwhile cannot put new bytes under an old hash). An
// existing name is never written again.
const COPY_SCRIPT = [
  "set -e",
  'pre=$(wc -c < "$1" | tr -d " ")',
  'if [ "$pre" -gt "$4" ]; then echo "big $pre"; exit 0; fi',
  'mkdir -p "$2"; t="$2/.part-$$"; trap \'rm -f "$t"\' EXIT',
  'cp "$1" "$t"',
  'size=$(wc -c < "$t" | tr -d " ")',
  'if [ "$size" -gt "$4" ]; then echo "big $size"; exit 0; fi',
  'h=$(shasum -a 1 < "$t" | cut -c1-40)',
  'd="$2/$h.$3"',
  'if [ -e "$d" ]; then echo "old $size $h"; exit 0; fi',
  'mv -f "$t" "$d"',
  'echo "new $size $h"',
].join("\n");

/** Copies a local picture into the cache. Resolves `{path, name}` (`path` relative to the app home,
 *  for image()) or `{error: "remote"|"unsupported"|"too-large"|"unreadable"}`. */
export async function cacheImage(abs, o = {}) {
  if (o.on) return { error: "remote" };
  const base = basename(abs);
  const dot = base.lastIndexOf(".");
  const ext = dot > 0 ? EXT[base.slice(dot + 1).toLowerCase()] : undefined;
  if (!ext) return { error: "unsupported" };
  await load();
  let r;
  try {
    r = await exec("sh", ["-c", COPY_SCRIPT, "lazuli", abs, imageDir(), ext, String(IMAGE_MAX)], { timeout: 30000 });
  } catch {
    return { error: "unreadable" };
  }
  const [state, size, hash] = r.stdout.trim().split(" ");
  if (state === "big") return { error: "too-large" };
  if ((state !== "new" && state !== "old") || !/^[0-9a-f]{40}$/.test(hash ?? "")) return { error: "unreadable" };
  const name = `${hash}.${ext}`;
  if (state === "new" || !entries.has(name)) await admit(name, Number(size) || 0);
  else touch(name);
  return { path: `${fromHome(imageDir())}/${name}`, name };
}

/** Writes a text picture (an SVG buffer) into the cache as `<sha1 of text>.<ext>`; same results. */
export async function cacheText(text, ext = "svg") {
  const size = utf8Length(text);
  if (size > IMAGE_MAX) return { error: "too-large" };
  await load();
  const name = `${sha1(text)}.${ext}`;
  const path = `${imageDir()}/${name}`;
  if (entries.has(name)) touch(name);
  else {
    try {
      await fs.mkdir(imageDir(), { recursive: true });
      if (!(await fs.exists(path))) await fs.writeFile(path, text);
    } catch {
      return { error: "unreadable" };
    }
    await admit(name, size);
  }
  return { path: `${fromHome(imageDir())}/${name}`, name };
}

// Source pictures by absolute path: {path, name, at} or {error, at}; and the ones being copied.
const sources = new Map();
const pending = new Set();

/** The cached copy of a source picture: `{state: "ready", path}`, `{state: "error", code}`, or
 *  `{state: "loading"}`, plus `stale` when it should be (re)fetched with fetchImage(). Safe in render. */
export function lookupImage(abs) {
  const hit = sources.get(abs);
  if (hit?.name) touch(hit.name);
  const stale = !hit || Date.now() - hit.at > IMAGE_TTL_MS;
  if (hit?.path) return { state: "ready", path: hit.path, stale };
  if (hit?.error) return { state: "error", code: hit.error, stale };
  return { state: "loading", stale };
}

/** Copies a source picture for lookupImage(); one copy at a time per source. */
export async function fetchImage(abs) {
  if (pending.has(abs)) return;
  pending.add(abs);
  try {
    const r = await cacheImage(abs);
    sources.set(abs, r.path ? { path: r.path, name: r.name, at: Date.now() } : { error: r.error, at: Date.now() });
  } finally {
    pending.delete(abs);
  }
}

/** Sources that changed on disk are looked at again. True when one of them was known. */
export function forgetSource(abs) {
  return sources.delete(abs);
}
