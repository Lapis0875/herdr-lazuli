// The PDF client behind a file tab's PDF view (DESIGN B9, ARCHITECTURE §5; spikes S3, S4).
//
// One PdfClient per shown PDF. It waits for the renderer build (sys/sidecars.js), reaches the pdfd daemon
// over loopback TCP (`net`, never while checking()), says hello with the discovery token, opens the file
// and renders the pages the view asks for: the visible ones first, then two on each side. Each answer
// names a JPEG under the app home that is never rewritten, so `image(path)` always shows new pixels.
// The socket is used one request at a time (write the line, read until its answer), as proven live (S4).
// A dropped connection is reconnected to the same daemon. A daemon that no longer answers hello is
// replaced once; needing that again within a minute fails with "daemon-lost" until retry(). Without pdfd
// it renders with pdftocairo (no search, no links, no outline), and without that it fails with
// "unavailable" and mode "preview": the view offers "Open in Preview" (sidecars.openInPreview). Every
// connect, hello, drop and give-up is logged with console.log under "[lazuli/pdf]".
//
// Use from a view:
//   init:    this.pdf = new PdfClient(file);
//            cx.spawn(async (cx) => this.pdf.run(cx));
//            cx.spawn(async (cx) => { while (this.pdf.state !== "closed") { await this.pdf.changes(); cx.notify(); } });
//   render:  this.pdf.want(firstVisible, lastVisible, widthPx)   (safe in render: no host calls)
//            this.pdf.page(n) → {path, width, height} | null;  this.pdf.pageError(n) → code | null
//   actions: await this.pdf.search(q) / links(n) / outline() / text(n)  → the daemon's answer or {error}
//   file changed on disk: this.pdf.reload();  after a failure: this.pdf.retry();  close(): this.pdf.dispose()
//
// state: "idle" | "preparing" (build, launch, open; "Preparing PDF renderer") | "ready" | "failed" | "closed".
// mode: null | "pdfd" | "pdftocairo" | "preview". info (when ready): {doc, pages, title, sizes:[[w,h]…],
// hasOutline}, sizes in display points. Error codes: the daemon's (auth bad_request not_found encrypted
// render_failed) and unavailable, daemon-lost, disconnected, unsupported, closed.

import net from "net";
import { Buffer } from "buffer";
import * as fs from "fs/promises";
import { createHash } from "crypto";
import { appHome, checking, exec } from "herdr";
import { checkRequest, createFramer, encode, parseReply } from "../core/proto.js";
import { evict } from "../core/lru.js";
import { buildPdfd, connectPdfd, detectFallback, popplerTool } from "../sys/sidecars.js";
import { debugLog, settings } from "../sys/store.js";

/** Pages rendered beyond each end of the visible range. */
export const RENDER_AHEAD = 2;
export const MIN_WIDTH = 16;
export const MAX_WIDTH = 8192;
export const SEARCH_LIMIT = 100;
/** Rendered pages kept beyond each end of the wanted range; farther ones are dropped and asked again. */
const KEEP_AROUND = 10;
/** A shown page is asked for again this often, so the daemon's LRU keeps it and a deleted file returns. */
const REVALIDATE_MS = 30000;
const HELLO_TIMEOUT_MS = 5000;
/** A request without an answer this long means a stuck daemon or socket: the connection is dropped. */
const REQUEST_TIMEOUT_MS = 20000;
const WATCH_MS = 2000;
/** A connection that lived this long earns back its automatic reconnect. */
const HEALTHY_MS = 60000;
const CAIRO_TIMEOUT_MS = 120000;
const CACHE_CAP = 300 * 1024 * 1024;
/** The daemon's render bounds, applied to pdftocairo too: height ≤ 4 × MAX_WIDTH, at most 64 MP. */
const MAX_PIXELS = 64000000;

const LOST = Object.freeze({ lost: true });
const TIMEOUT = Object.freeze({ timeout: true });
/** Connections in a row lost before the daemon answered anything after hello: then the client gives up. */
const MAX_BARREN = 3;
/** Transitions: console and, with `"debug": true` in settings.json, data/lazuli/debug.log. */
const log = (msg) => {
  console.log(`[lazuli/pdf] ${msg}`);
  debugLog("pdf", msg);
};
/** Every step (each write, read, line, request): only with `"debug": true`. */
const tracing = () => settings().debug === true;
const trace = (msg) => {
  if (tracing()) log(msg);
};
const errText = (e) => e?.message ?? String(e);

/** A request line with every non-ASCII UTF-16 unit as \uXXXX (valid JSON: such units only occur inside
 *  strings), so the bytes on the wire never depend on how the host encodes a string (NFD Hangul paths). */
const asciiLine = (s) => s.replace(/[\u007f-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);

const clampWidth = (w) => Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(Number(w) || 0)));

/** The pages to render, most wanted first: the visible range [first, last] top to bottom, then
 *  last+1, first-1, last+2, first-2, … up to `ahead` on each side, all within 1…count. */
export function pagesToRender(first, last, count, ahead = RENDER_AHEAD) {
  if (!Number.isInteger(count) || count <= 0) return [];
  const clamp = (v, lo) => Math.min(count, Math.max(lo, Math.trunc(Number(v) || lo)));
  const a = clamp(first, 1);
  const b = clamp(last, a);
  const out = [];
  for (let p = a; p <= b; p++) out.push(p);
  for (let k = 1; k <= ahead; k++) {
    if (b + k <= count) out.push(b + k);
    if (a - k >= 1) out.push(a - k);
  }
  return out;
}

let oddRead = false;

/** What sock.read() resolved with, as bytes. The host gives a Uint8Array (gpui-kit.d.ts, S4); anything
 *  else is converted, and logged once. */
function toBytes(v) {
  if (v instanceof Uint8Array) return v;
  if (!oddRead) {
    oddRead = true;
    log(`sock.read() gave ${Object.prototype.toString.call(v)}; converting`);
  }
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (typeof v === "string") return Uint8Array.from(Buffer.from(v, "utf8"));
  if (v && typeof v.length === "number") return Uint8Array.from(v);
  return new Uint8Array(0);
}

// One authenticated connection, used the way S4 proved live and cockpit's hub client does: one request
// at a time, its line written, then reads until its answer line. No read waits while the connection is
// idle and no write happens while a read waits.
class Conn {
  #sock;
  #framer = createFramer();
  #lines = [];
  #queue = []; // {op, fields, resolve, started}; the first is in flight
  #busy = false;
  #nextId = 1;
  #onClose;
  closed = false;
  /** Answers received (hello included). */
  answers = 0;

  /** `onClose` runs once when the connection closes (the client's work wake-up). */
  constructor(sock, label, onClose) {
    this.#sock = sock;
    this.label = label;
    this.#onClose = onClose;
  }

  /** Resolves with parseReply's answer, or LOST when the connection goes first. */
  request(op, fields = {}) {
    if (this.closed) return Promise.resolve(LOST);
    return new Promise((resolve) => {
      this.#queue.push({ op, fields, resolve, started: null });
      this.#pump();
    });
  }

  async #pump() {
    if (this.#busy) return;
    this.#busy = true;
    while (!this.closed && this.#queue.length) {
      const job = this.#queue[0];
      job.started = Date.now();
      let r;
      try {
        r = await this.#exchange(job.op, job.fields);
      } catch (e) {
        log(`${this.label}: ${job.op} failed: ${errText(e)}`);
        r = LOST;
      }
      if (this.#queue[0] === job) this.#queue.shift();
      job.resolve(r);
      if (r === LOST) this.close(`lost during ${job.op}`);
    }
    this.#busy = false;
  }

  async #exchange(op, fields) {
    const id = this.#nextId++;
    const line = asciiLine(encode({ ...fields, id, op }));
    this.#mark(`write #${id} ${op}`);
    trace(`${this.label}: write #${id} ${op} (${line.length} bytes)`);
    const t0 = Date.now();
    await this.#sock.write(line);
    trace(`${this.label}: write #${id} resolved in ${Date.now() - t0} ms`);
    this.#mark(`answer to #${id} ${op}`);
    for (;;) {
      const got = await this.#readLine();
      if (got === null) return LOST;
      const r = parseReply(got);
      const what = r.bad ? "not a reply" : r.event !== undefined ? `event ${r.event}` : `id ${JSON.stringify(r.id)} ${r.ok ? "ok" : `error ${r.error.code}`}`;
      trace(`${this.label}: line of ${got.length} chars: ${what}`);
      // Skips events, junk and late answers to requests given up on.
      if (r.bad || r.event !== undefined || r.id !== id) {
        log(`${this.label}: skipped a line while waiting for #${id} (${what}): ${got.slice(0, 120)}`);
        continue;
      }
      this.answers++;
      this.#mark(null);
      return r;
    }
  }

  async #readLine() {
    while (!this.#lines.length) {
      if (this.closed) return null;
      trace(`${this.label}: read(65536)`);
      const t0 = Date.now();
      const got = await this.#sock.read(65536);
      if (got == null) {
        if (!this.closed) log(`${this.label}: read gave ${got} after ${Date.now() - t0} ms: the daemon closed the connection`);
        return null;
      }
      const bytes = toBytes(got);
      trace(`${this.label}: read → ${bytes.length} bytes in ${Date.now() - t0} ms`);
      const { lines, error } = this.#framer.push(bytes);
      this.#lines.push(...lines);
      if (error) {
        log(`${this.label}: ${error}`);
        return null;
      }
    }
    return this.#lines.shift();
  }

  #step = null;

  #mark(what) {
    this.#step = what ? { what, since: Date.now() } : null;
  }

  /** What the connection waits for (`write #3 open`, `answer to #3 open`) and since when, or null. */
  waiting() {
    return this.closed ? null : this.#step;
  }

  /** When the request in flight was sent, or null. */
  oldest() {
    return this.#queue[0]?.started ?? null;
  }

  close(why = "closed") {
    if (this.closed) return;
    this.closed = true;
    log(`${this.label}: connection closed (${why})`);
    try {
      this.#sock.close();
    } catch {
      // Already closed.
    }
    const queue = this.#queue;
    this.#queue = [];
    for (const job of queue) job.resolve(LOST);
    this.#onClose?.();
  }
}

// pdftocairo fallback: file identity, page sizes, renders, cache bound.

/** The file's revision as pdfd builds it: "<mtime s>.<ns>|<size>|<inode>|<ctime s>.<ns>" of a regular
 *  file, symlinks followed; null when there is none. */
export async function fileRevision(file) {
  try {
    const r = await exec("stat", ["-L", "-f", "%HT|%.9Fm|%z|%i|%.9Fc", file]);
    const m = r.code === 0 ? /^Regular File\|(\d+\.\d{9}\|\d+\|\d+\|\d+\.\d{9})$/.exec(r.stdout.trim()) : null;
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** pdfd's docKey: the first 16 hex of sha1("<path>|<revision>"), so a rewrite within one second at the
 *  same size still names a new cache folder. */
export const docKeyOf = (file, revision) =>
  String(createHash("sha1").update(`${file}|${revision}`).digest("hex")).slice(0, 16);

async function cairoOpen(cairo, file) {
  trace(`pdftocairo: stat ${file}`);
  const stamp = await fileRevision(file);
  trace(`pdftocairo: stat → ${stamp}`);
  if (!stamp) return { error: "not_found" };
  const pdfinfo = popplerTool(cairo, "pdfinfo");
  let r;
  try {
    trace(`pdftocairo: ${pdfinfo} (pages, title)`);
    r = await exec(pdfinfo, ["-enc", "UTF-8", file], { timeout: 60000 });
    trace(`pdftocairo: pdfinfo → code ${r.code}`);
  } catch (e) {
    log(`pdfinfo failed: ${errText(e)}`);
    return { error: "render_failed" };
  }
  if (r.code !== 0) return { error: /password/i.test(r.stderr) ? "encrypted" : "render_failed" };
  const pages = Number(/^Pages:\s+(\d+)/m.exec(r.stdout)?.[1] ?? 0);
  if (!pages) return { error: "render_failed" };
  const title = /^Title:\s+(.*)$/m.exec(r.stdout)?.[1]?.trim() || null;
  const sizes = new Array(pages).fill(null);
  try {
    trace(`pdftocairo: pdfinfo page sizes 1-${pages}`);
    const per = await exec(pdfinfo, ["-f", "1", "-l", String(pages), file], { timeout: CAIRO_TIMEOUT_MS });
    trace(`pdftocairo: page sizes → code ${per.code}`);
    const size = new Map();
    const rot = new Map();
    for (const line of per.stdout.split("\n")) {
      let m = /^Page\s+(\d+)\s+size:\s+([\d.]+) x ([\d.]+)/.exec(line);
      if (m) size.set(Number(m[1]), [Number(m[2]), Number(m[3])]);
      m = /^Page\s+(\d+)\s+rot:\s+(-?\d+)/.exec(line);
      if (m) rot.set(Number(m[1]), ((Number(m[2]) % 360) + 360) % 360);
    }
    for (let p = 1; p <= pages; p++) {
      const s = size.get(p);
      if (s) sizes[p - 1] = rot.get(p) % 180 === 90 ? [s[1], s[0]] : s;
    }
  } catch (e) {
    log(`pdfinfo sizes failed: ${errText(e)}`);
  }
  const first = sizes.find(Boolean) ?? [612, 792];
  return { doc: docKeyOf(file, stamp), pages, title, sizes: sizes.map((s) => s ?? first), hasOutline: false };
}

let seq = 0;
/** Rises past the clock and every earlier value, as the daemon's does: a name is never reused. */
const nextSeq = () => (seq = Math.max(seq + 1, Date.now()));

// The daemon bounds the cache itself. Without it (pdftocairo), this keeps the folder at most CACHE_CAP: the
// folder is measured once, every render is added, and the least recently used renders go after each one.
// Sizes count whole 4 KiB blocks, as pdfd does.
const blocks = (bytes) => Math.ceil(bytes / 4096) * 4096;
let cairoCache = null; // absolute path → {size, used (ms)}, once measured
let cacheOps = Promise.resolve();

async function measureCache() {
  const root = `${appHome()}/data/lazuli/cache/pdf`;
  const entries = new Map();
  try {
    const r = await exec("find", [root, "-type", "f", "-name", "*.jpg", "-exec", "stat", "-f", "%m %z %N", "{}", "+"], { timeout: 60000 });
    for (const line of r.stdout.split("\n")) {
      const m = /^(\d+) (\d+) (.+)$/.exec(line);
      if (m) entries.set(m[3], { size: blocks(Number(m[2])), used: Number(m[1]) * 1000 });
    }
  } catch (e) {
    log(`measuring the render cache failed: ${errText(e)}`);
  }
  let total = 0;
  for (const e of entries.values()) total += e.size;
  log(`render cache: ${entries.size} files, ${(total / 1048576).toFixed(1)} MB`);
  return entries;
}

async function fileSize(abs) {
  try {
    const r = await exec("stat", ["-f", "%z", abs]);
    return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
  } catch {
    return 0;
  }
}

/** Records a render just written (or reused, `fresh` false) and deletes the least recently used renders
 *  while the folder is over the cap. One update at a time; resolves when it is done. */
function noteCairoRender(abs, fresh) {
  cacheOps = cacheOps
    .then(async () => {
      cairoCache ??= await measureCache();
      const known = cairoCache.get(abs);
      cairoCache.set(abs, { size: known && !fresh ? known.size : blocks(await fileSize(abs)), used: Date.now() });
      const names = evict([...cairoCache].map(([name, e]) => ({ name, size: e.size, used: e.used })), CACHE_CAP);
      for (const name of names) cairoCache.delete(name);
      for (let i = 0; i < names.length; i += 200) await exec("rm", ["-f", ...names.slice(i, i + 200)]);
      if (names.length) trace(`render cache: deleted ${names.length} least recently used`);
    })
    .catch((e) => log(`render cache update failed: ${errText(e)}`));
  return cacheOps;
}

async function exists(path) {
  try {
    return await fs.exists(path);
  } catch {
    return false;
  }
}

export class PdfClient {
  /** The open file (absolute). */
  file;
  state = "idle";
  mode = null;
  error = null;
  info = null;

  #pages = new Map(); // page → {path, width, height, at}
  #failed = new Map(); // "<page>:<width>" → error code
  #wanted = null; // {first, last, width}
  #order = [];
  #width = 0;
  #waiters = [];
  #work = null;
  #conn = null;
  #gen = 0;
  #started = false;
  #disposed = false;
  #retry = false;

  constructor(file) {
    this.file = file;
  }

  /** The latest render of a page ({path, width, height}; `width` may differ from the wanted one while a
   *  new render is on its way), or null. */
  page(n) {
    const e = this.#pages.get(n);
    return e ? { path: e.path, width: e.width, height: e.height } : null;
  }

  /** The error code of a page that failed to render at the wanted width, or null. */
  pageError(n) {
    return this.#failed.get(`${n}:${this.#width}`) ?? null;
  }

  /** Resolves at the next change of state, info or a page. */
  changes() {
    if (this.state === "closed") return Promise.resolve();
    return new Promise((resolve) => this.#waiters.push(resolve));
  }

  /** The visible pages and the width (device pixels) to render them at. Safe in render(). */
  want(first, last, width) {
    const w = clampWidth(width);
    const prev = this.#wanted;
    if (prev && prev.first === first && prev.last === last && prev.width === w) return;
    this.#wanted = { first, last, width: w };
    this.#plan();
    this.#poke();
  }

  /** The file changed on disk: open it again and render anew (also after a failure). */
  reload() {
    this.#gen++;
    this.#retry = true;
    this.#poke();
  }

  /** Try again: after the client failed, or for pages that failed to render. */
  retry() {
    this.#failed.clear();
    this.#retry = true;
    this.#poke();
    this.#emit();
  }

  /** Stops everything: the connection closes and run() returns. */
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#conn?.close("tab closed");
    this.#poke();
    this.#setState("closed");
  }

  async search(query, limit = SEARCH_LIMIT) {
    return this.#call("search", { query, limit });
  }

  async links(page) {
    return this.#call("links", { page });
  }

  async outline() {
    return this.#call("outline", {});
  }

  /** The page's text ("Copy page text"); pdftotext's under the pdftocairo fallback. */
  async text(page) {
    if (this.mode === "pdftocairo") return this.#cairoText(page);
    return this.#call("text", { page });
  }

  /** The client's life: runs until dispose(). Start it with cx.spawn from the view. */
  async run(cx) {
    if (checking() || this.#started) return;
    this.#started = true;
    this.#watch(cx).catch(() => {});
    try {
      while (!this.#disposed) {
        this.#retry = false;
        await this.#session(cx);
        if (this.#disposed) break;
        while (this.state === "failed" && !this.#retry && !this.#disposed) await this.#wait();
      }
    } catch (e) {
      log(`client failed: ${errText(e)}`);
    } finally {
      this.#conn?.close("tab closed");
      this.#setState("closed");
    }
  }

  // State and wake-ups.

  #emit() {
    const waiters = this.#waiters;
    this.#waiters = [];
    for (const resolve of waiters) resolve();
  }

  #setState(state) {
    if (this.state === "closed") return;
    if (this.state !== state) log(`${this.#tag}: ${this.state} → ${state}${this.mode ? ` (${this.mode})` : ""}${state === "failed" ? `: ${this.error}` : ""}`);
    this.state = state;
    this.#emit();
  }

  get #tag() {
    return String(this.file).slice(String(this.file).lastIndexOf("/") + 1);
  }

  #fail(code) {
    this.error = code;
    this.#setState("failed");
  }

  #wait() {
    if (!this.#work) {
      let resolve;
      const promise = new Promise((r) => (resolve = r));
      this.#work = { promise, resolve };
    }
    return this.#work.promise;
  }

  #poke() {
    const w = this.#work;
    this.#work = null;
    w?.resolve();
  }

  #plan() {
    const want = this.#wanted;
    if (!want || !this.info) {
      trace(`${this.#tag}: plan waits for ${want ? "the document" : "want() from the view"}`);
      return;
    }
    this.#order = pagesToRender(want.first, want.last, this.info.pages);
    this.#width = want.width;
    trace(`${this.#tag}: want ${want.first}-${want.last} at ${want.width} px → order ${this.#order.join(",")}`);
    if (!this.#order.length) return;
    const lo = Math.min(...this.#order) - KEEP_AROUND;
    const hi = Math.max(...this.#order) + KEEP_AROUND;
    for (const p of [...this.#pages.keys()]) if (p < lo || p > hi) this.#pages.delete(p);
  }

  #opened(info) {
    this.info = info;
    this.error = null;
    this.#plan();
    this.#setState("ready");
  }

  #reset() {
    this.info = null;
    this.#pages.clear();
    this.#failed.clear();
    this.#order = [];
  }

  /** The next render: a wanted page missing at the wanted width, else a shown page due a check. */
  #nextJob() {
    const width = this.#width;
    for (const page of this.#order) {
      if (this.#failed.has(`${page}:${width}`)) continue;
      const e = this.#pages.get(page);
      if (!e || e.width !== width) return { page, width, revalidate: false };
    }
    const now = Date.now();
    for (const page of this.#order) {
      const e = this.#pages.get(page);
      if (e && e.width === width && now - e.at > REVALIDATE_MS) {
        e.at = now;
        return { page, width, revalidate: true };
      }
    }
    return null;
  }

  /** Renders wanted pages until the connection goes ("lost"), reload() ("reload") or dispose() ("closed"). */
  async #renderLoop(conn, gen, render) {
    while (!this.#disposed && gen === this.#gen) {
      if (conn?.closed) return "lost";
      const job = this.#nextJob();
      if (!job) {
        // One waiter: close() of the connection wakes it through the same #poke().
        await this.#wait();
        continue;
      }
      trace(`${this.#tag}: render page ${job.page} at ${job.width} px${job.revalidate ? " (check)" : ""}`);
      const t0 = Date.now();
      const r = await render(job);
      trace(`${this.#tag}: render page ${job.page} → ${r.lost ? "lost" : r.ok ? r.value.path : `error ${r.error.code}`} in ${Date.now() - t0} ms`);
      if (r.lost) return "lost";
      if (gen !== this.#gen) break;
      if (r.ok) {
        const v = r.value;
        const old = this.#pages.get(job.page);
        const same = old && old.path === v.path && old.width === v.width && old.height === v.height;
        this.#pages.set(job.page, { path: v.path, width: v.width, height: v.height, at: Date.now() });
        this.#failed.delete(`${job.page}:${job.width}`);
        if (!same) this.#emit();
      } else {
        this.#failed.set(`${job.page}:${job.width}`, r.error.code);
        this.#emit();
      }
    }
    return this.#disposed ? "closed" : "reload";
  }

  async #session(cx) {
    this.mode = null;
    this.error = null;
    this.#reset();
    this.#setState("preparing");
    trace(`${this.#tag}: waiting for the pdfd build`);
    const built = await buildPdfd(cx);
    trace(`${this.#tag}: build → ${built.state}${built.reason ? ` (${built.reason})` : ""}`);
    if (this.#disposed) return;
    if (built.state === "ready") {
      const end = await this.#runDaemon(cx);
      if (end !== "unavailable") return;
    }
    trace(`${this.#tag}: looking for pdftocairo`);
    const fb = await detectFallback();
    log(`${this.#tag}: fallback ${fb.kind}`);
    if (this.#disposed) return;
    if (fb.kind === "pdftocairo") {
      await this.#runCairo(fb.bin);
      return;
    }
    this.mode = "preview";
    this.#fail("unavailable");
  }

  // The daemon.

  /** A connection that passed hello, or null. Every outcome is logged. */
  async #connect(cx, where) {
    const label = `pdfd pid ${where.pid} port ${where.port}`;
    let sock;
    try {
      sock = await net.connect("127.0.0.1", where.port);
    } catch (e) {
      log(`${label}: connect failed: ${errText(e)}`);
      return null;
    }
    const conn = new Conn(sock, label, () => this.#poke());
    const hello = await Promise.race([conn.request("hello", { token: where.token }), cx.sleep(HELLO_TIMEOUT_MS).then(() => TIMEOUT)]);
    if (hello === TIMEOUT || !hello.ok) {
      const why = hello === TIMEOUT ? `no hello answer in ${HELLO_TIMEOUT_MS} ms` : hello.lost ? "closed before hello" : `hello refused (${hello.error.code})`;
      log(`${label}: ${why}`);
      conn.close(why);
      return null;
    }
    log(`${label}: connected for ${this.file}`);
    return conn;
  }

  /**
   * Serves the file from pdfd until it closes, fails or needs the fallback ("unavailable"). A dropped
   * connection is reconnected to the same daemon; only a daemon that no longer answers hello on a fresh
   * connection is replaced, at most once a minute. Connections that keep dropping before the daemon
   * answers anything after hello give up with "daemon-lost".
   */
  async #runDaemon(cx) {
    let stale = null;
    let relaunchedAt = -Infinity;
    let barren = 0;
    for (;;) {
      trace(`${this.#tag}: asking for the daemon${stale ? ` (pid ${stale.pid} did not answer)` : ""}`);
      const where = await connectPdfd(cx, { stale });
      trace(`${this.#tag}: daemon → ${where.error ? `error ${where.error}` : `pid ${where.pid} port ${where.port}`}`);
      if (this.#disposed) return "closed";
      if (where.error) {
        log(`pdfd not reachable: ${where.error}${where.reason ? ` (${where.reason})` : ""}`);
        return "unavailable";
      }
      const conn = await this.#connect(cx, where);
      if (this.#disposed) {
        conn?.close("tab closed");
        return "closed";
      }
      if (!conn) {
        if (stale) {
          log("the new pdfd did not answer either; falling back");
          return "unavailable";
        }
        if (Date.now() - relaunchedAt < HEALTHY_MS) {
          log("pdfd stopped answering again within a minute; giving up");
          this.#fail("daemon-lost");
          return "failed";
        }
        // A daemon that left its discovery file behind, or does not answer: launch another.
        relaunchedAt = Date.now();
        stale = where;
        continue;
      }
      stale = null;
      this.mode = "pdfd";
      this.#conn = conn;
      const end = await this.#serveDaemon(conn);
      this.#conn = null;
      conn.close(end === "lost" ? "lost" : `session ${end}`);
      if (end !== "lost" || this.#disposed) return end;
      barren = conn.answers > 1 ? 0 : barren + 1;
      if (barren >= MAX_BARREN) {
        log(`${MAX_BARREN} connections in a row dropped before any answer; giving up`);
        this.#fail("daemon-lost");
        return "failed";
      }
      // The pages shown stay while the same daemon is asked again.
      log(`${conn.label}: reconnecting`);
    }
  }

  async #serveDaemon(conn) {
    for (;;) {
      const gen = this.#gen;
      trace(`${this.#tag}: open ${this.file}`);
      const opened = await conn.request("open", { path: this.file });
      log(`${this.#tag}: open → ${opened.lost ? "lost" : opened.ok ? `${opened.value.pages} pages, doc ${opened.value.doc}` : `error ${opened.error.code}`}`);
      if (opened.lost) return "lost";
      if (this.#disposed) return "closed";
      if (!opened.ok) {
        this.#fail(opened.error.code);
        return "failed";
      }
      const v = opened.value;
      const doc = v.doc;
      this.#opened({
        doc,
        pages: Number.isInteger(v.pages) ? v.pages : 0,
        title: typeof v.title === "string" ? v.title : null,
        sizes: Array.isArray(v.sizes) ? v.sizes : [],
        hasOutline: v.hasOutline === true,
      });
      const end = await this.#renderLoop(conn, gen, (job) => conn.request("render", { doc, page: job.page, width: job.width }));
      if (end !== "reload") return end;
      await conn.request("close", { doc });
      this.#reset();
      this.#setState("preparing");
    }
  }

  /** The connection once the document is open; null when the client failed, closed, or has no daemon. */
  async #readyConn() {
    while (!this.#disposed) {
      if (this.state === "ready" && this.#conn && !this.#conn.closed) return this.#conn;
      if (this.state === "failed" || this.mode === "pdftocairo" || this.mode === "preview") return null;
      await this.changes();
    }
    return null;
  }

  /** A request about the open document, sent again once if the connection drops meanwhile. */
  async #call(op, fields) {
    trace(`${this.#tag}: ${op} ${JSON.stringify(fields)} asked (state ${this.state})`);
    for (let attempt = 0; attempt < 2; attempt++) {
      const conn = await this.#readyConn();
      if (!conn) {
        if (this.mode === "pdftocairo" || this.mode === "preview") return { error: "unsupported" };
        return { error: this.#disposed ? "closed" : (this.error ?? "closed") };
      }
      const msg = { op, doc: this.info.doc, ...fields };
      if (checkRequest(msg)) return { error: "bad_request" };
      const r = await conn.request(op, { doc: this.info.doc, ...fields });
      if (r.lost) continue;
      return r.ok ? r.value : { error: r.error.code };
    }
    return { error: "disconnected" };
  }

  /** Every 2 s: reports a request that has waited 2 s or more (which step), drops a connection whose
   *  request has waited 20 s (a stuck daemon or socket; the reconnect follows), and wakes the render loop
   *  so shown pages are checked again when due. */
  async #watch(cx) {
    while (!this.#disposed) {
      await cx.sleep(WATCH_MS);
      const conn = this.#conn;
      const step = conn?.waiting();
      if (step && Date.now() - step.since >= WATCH_MS) log(`${conn.label}: still waiting for ${step.what} after ${Date.now() - step.since} ms`);
      const since = conn?.oldest();
      if (since != null && Date.now() - since > REQUEST_TIMEOUT_MS) {
        log(`${conn.label}: no answer in ${REQUEST_TIMEOUT_MS / 1000} s; dropping the connection`);
        conn.close("no answer");
      }
      if (this.state === "ready") this.#poke();
    }
  }

  // The pdftocairo fallback.

  async #runCairo(cairo) {
    this.mode = "pdftocairo";
    for (;;) {
      const gen = this.#gen;
      const info = await cairoOpen(cairo, this.file);
      if (this.#disposed) return;
      if (info.error) {
        this.#fail(info.error);
        return;
      }
      this.#opened(info);
      const end = await this.#renderLoop(null, gen, (job) => this.#cairoRender(cairo, job));
      if (end !== "reload") return;
      this.#reset();
      this.#setState("preparing");
    }
  }

  async #cairoRender(cairo, { page, width, revalidate }) {
    const old = this.#pages.get(page);
    if (revalidate && old && (await exists(`${appHome()}/${old.path}`))) {
      await noteCairoRender(`${appHome()}/${old.path}`, false);
      return { ok: true, value: old };
    }
    const [w, h] = this.info.sizes[page - 1] ?? [1, 1];
    const scaled = Math.max(1, Math.round((h * width) / w));
    if (!(w > 0 && h > 0 && Number.isFinite(scaled) && scaled <= 4 * MAX_WIDTH && width * scaled <= MAX_PIXELS)) {
      log(`pdftocairo page ${page}: ${w}x${h} pt is too large to draw ${width} px wide`);
      return { ok: false, error: { code: "render_failed" } };
    }
    const dir = `data/lazuli/cache/pdf/${this.info.doc}`;
    const base = `${dir}/p${page}-w${width}-${nextSeq()}`;
    try {
      await fs.mkdir(`${appHome()}/${dir}`, { recursive: true });
      // -scale-to-y -1 keeps the aspect ratio; -singlefile writes <base>.jpg without a page suffix.
      const r = await exec(
        cairo,
        ["-jpeg", "-jpegopt", "quality=90", "-scale-to-x", String(width), "-scale-to-y", "-1",
          "-f", String(page), "-l", String(page), "-singlefile", this.file, `${appHome()}/${base}`],
        { timeout: CAIRO_TIMEOUT_MS },
      );
      if (r.code !== 0) {
        log(`pdftocairo page ${page}: ${r.stderr.trim()}`);
        return { ok: false, error: { code: "render_failed" } };
      }
    } catch (e) {
      log(`pdftocairo page ${page}: ${errText(e)}`);
      return { ok: false, error: { code: "render_failed" } };
    }
    // The cap holds before the next render starts.
    await noteCairoRender(`${appHome()}/${base}.jpg`, true);
    return { ok: true, value: { path: `${base}.jpg`, width, height: scaled } };
  }

  async #cairoText(page) {
    if (this.state !== "ready" || !this.info) return { error: this.error ?? "closed" };
    if (!Number.isInteger(page) || page < 1 || page > this.info.pages) return { error: "bad_request" };
    const fb = await detectFallback();
    if (fb.kind !== "pdftocairo") return { error: "unsupported" };
    try {
      const r = await exec(popplerTool(fb.bin, "pdftotext"), ["-f", String(page), "-l", String(page), "-enc", "UTF-8", this.file, "-"], { timeout: 60000 });
      if (r.code !== 0) return { error: "render_failed" };
      return { text: r.stdout.replace(/\f$/, "").replace(/\n+$/, "") };
    } catch {
      return { error: "unsupported" };
    }
  }
}
