// Markdown parsed in pieces (DESIGN B6). marked's lexer slows down more than linearly on long text,
// and a preview that follows typing parses on every pause, so the text is cut into chunks at places
// where Markdown cannot carry a block across (a heading at column 0, or a blank line before an
// unindented line outside code fences, raw HTML and lists), each chunk is lexed alone (core/md-tree.js
// parse) and kept by its text: an edit re-lexes only its own chunk. A first parse of a long file runs a
// few milliseconds at a time (step), so no single host call carries all of it.

import { parse, slug } from "../../core/md-tree.js";
import { plainText } from "./inline.js";

/** A chunk grows to about this many characters before it is cut at the next safe place. */
export const CHUNK_CHARS = 2000;
/** Past this size a run of list items is cut between two items too. */
const HARD_CHARS = 8000;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ORDERED = /^\d{1,9}[.)](\s|$)/;
const REF_DEF = /^ {0,3}\[[^\]\n]+\]:\s*\S/;
const RAW_START = [
  [/^<!--/, "-->"],
  [/^<(script|pre|style|textarea)(\s|>|$)/i, null],
  [/^<\?/, "?>"],
  [/^<!\[CDATA\[/, "]]>"],
];

const SPACE = 32;
const TAB = 9;

/** A list item's first line at column 0: "-", "*", "+" or "1." / "1)" and a space or the end. */
function isItem(line) {
  const c = line.charCodeAt(0);
  if (c === 45 || c === 42 || c === 43) {
    const n = line.charCodeAt(1);
    return line.length === 1 || n === SPACE || n === TAB;
  }
  return c >= 48 && c <= 57 && ORDERED.test(line);
}

/** An ATX heading at column 0. */
function isHeading(line) {
  if (line.charCodeAt(0) !== 35) return false;
  let n = 1;
  while (n < 7 && line.charCodeAt(n) === 35) n++;
  if (n > 6) return false;
  const c = line.charCodeAt(n);
  return n === line.length || c === SPACE || c === TAB;
}

/** The text cut into chunks (lines kept whole, joined with "\n"; joined back with "\n" they give the
 *  text again), the reference definition lines found outside code, and the indexes of chunks cut
 *  inside a long list (they go on with the list before them): `{chunks, defs, cont}`. */
export function splitChunks(text) {
  const lines = String(text ?? "").split("\n");
  const chunks = [];
  const defs = [];
  const cont = new Set();
  let start = 0;
  let size = 0;
  let fence = null;
  let raw = null;
  let prevBlank = false;
  let prevItem = false;
  const cut = (i) => {
    if (i > start) chunks.push(lines.slice(start, i).join("\n"));
    start = i;
    size = 0;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    let lead = 0;
    while (lead < 4 && line.charCodeAt(lead) === SPACE) lead++;
    const cl = line.charCodeAt(lead);
    const maybeFence = lead < 4 && (cl === 96 || cl === 126);
    let item = false;
    if (fence) {
      if (maybeFence) {
        const m = line.match(FENCE);
        if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.trim() === m[1]) fence = null;
      }
    } else if (raw) {
      if (line.toLowerCase().includes(raw)) raw = null;
    } else {
      const atZero = line.length > 0 && c0 !== SPACE && c0 !== TAB;
      item = atZero && isItem(line);
      if (atZero && isHeading(line)) cut(i);
      else if (atZero && prevBlank && !item && size >= CHUNK_CHARS) cut(i);
      else if (item && (prevBlank || prevItem) && size >= HARD_CHARS) {
        cut(i);
        cont.add(chunks.length);
      }
      const f = maybeFence ? line.match(FENCE) : null;
      if (f) fence = f[1];
      else if (c0 === 60) {
        for (const [re, end] of RAW_START) {
          const m = line.match(re);
          if (!m) continue;
          const close = end ?? `</${m[1].toLowerCase()}>`;
          if (!line.toLowerCase().includes(close, m[0].length)) raw = close;
          break;
        }
      } else if (lead < 4 && cl === 91 && REF_DEF.test(line)) defs.push(line);
    }
    prevBlank = line.length === 0 || line.trim() === "";
    prevItem = item;
    size += line.length + 1;
  }
  cut(lines.length);
  return { chunks, defs, cont };
}

/** md-tree's heading ids, made unique over the whole document (chunks are lexed alone). */
function uniqueId(base, ids) {
  const seen = ids.get(base);
  if (seen === undefined) {
    ids.set(base, 0);
    return base;
  }
  let n = seen;
  let id;
  do {
    n += 1;
    id = `${base}-${n}`;
  } while (ids.has(id));
  ids.set(base, n);
  ids.set(id, 0);
  return id;
}

/** Gives every heading its id in document order, as one parse of the whole text would. */
export function assignHeadingIds(blocks, ids = new Map()) {
  for (const b of blocks) {
    if (b.type === "heading") b.id = uniqueId(slug(plainText(b.inlines)), ids);
    else if (b.type === "list") for (const it of b.items) assignHeadingIds(it.blocks, ids);
    else if (b.type === "blockquote") assignHeadingIds(b.blocks, ids);
  }
  return blocks;
}

const now = () => Date.now();

/** Parses texts chunk by chunk, keeping each chunk's blocks for the next parse. */
export class MdParser {
  constructor() {
    this.cache = new Map(); // chunk text → [blocks of its 1st, 2nd, … occurrence]
    this.defs = "";
    /** Rises when the reference definitions change: blocks parsed before resolve links differently. */
    this.defsRev = 0;
    this.job = null;
  }

  /** Starts a parse of `text` (the one running is dropped). */
  begin(text) {
    const { chunks, defs, cont } = splitChunks(text);
    // Reference definitions apply to the whole file: each chunk is lexed with all of them before it,
    // so a change to them makes every chunk new.
    const joined = defs.join("\n");
    if (joined !== this.defs) {
      this.cache.clear();
      this.defs = joined;
      this.defsRev += 1;
    }
    this.job = { chunks, cont, seen: new Map(), parts: [], done: 0 };
    return this.job;
  }

  /** Whether chunks of the running parse are still to lex. */
  get busy() {
    return Boolean(this.job) && this.job.done < this.job.chunks.length;
  }

  /** Lexes chunks for about `budgetMs` (at least one). Returns the blocks parsed so far, in order,
   *  with heading ids assigned, and whether the parse is done: `{blocks, done}`. */
  step(budgetMs) {
    const job = this.job;
    if (!job) return { blocks: [], done: true };
    const t0 = now();
    while (job.done < job.chunks.length) {
      const chunk = job.chunks[job.done];
      const n = job.seen.get(chunk) ?? 0;
      job.seen.set(chunk, n + 1);
      let list = this.cache.get(chunk);
      if (!list) this.cache.set(chunk, (list = []));
      if (!list[n]) list[n] = parse(this.defs ? `${this.defs}\n\n${chunk}` : chunk);
      job.parts.push(list[n]);
      job.done += 1;
      if (now() - t0 >= budgetMs) break;
    }
    const done = job.done >= job.chunks.length;
    if (done) {
      for (const [chunk, list] of [...this.cache]) {
        const used = job.seen.get(chunk) ?? 0;
        if (!used) this.cache.delete(chunk);
        else if (list.length > used) list.length = used;
      }
    }
    const blocks = assignHeadingIds(joinParts(job.parts, job.cont));
    return { blocks, done };
  }
}

/** The chunks' blocks in order. A chunk cut inside a long list goes on with the list before it: its
 *  first list is a copy marked `cont` (drawn without the gap between lists) and, when ordered,
 *  numbered on from that list (an item's own number only counts for a list's first item). The cached
 *  block keeps its own values. */
function joinParts(parts, cont) {
  const out = [];
  parts.forEach((part, j) => {
    part.forEach((b, i) => {
      const prev = out[out.length - 1];
      if (i === 0 && cont.has(j) && b.type === "list" && prev?.type === "list" && prev.ordered === b.ordered) {
        out.push(b.ordered ? { ...b, cont: true, start: (prev.start ?? 1) + prev.items.length } : { ...b, cont: true });
      } else out.push(b);
    });
  });
  return out;
}
