// Markdown preview data (DESIGN B6): marked's tokens (gfm) turned into a small render tree of blocks
// and styled inline runs, each block keyed by a hash of its source so a view can reuse unchanged
// blocks; plus heading slugs and link resolution. Pure apart from the vendored marked.
//
// marked 18.2.1 token fields used here (checked by lexing in Node and QuickJS, spike S7):
// blocks heading{depth,tokens} paragraph{tokens} text{tokens?,text} list{ordered,start ("" when
// unordered),items[{task,checked,tokens}]} (a task item's first token is {type:"checkbox"})
// blockquote{tokens} code{lang ("" or absent),text} table{align,header[{tokens}],rows[[{tokens}]]}
// hr html{text} space def; inlines text{text,tokens?} escape{text} strong em del {tokens}
// codespan{text} br link{href,title,tokens} image{href,title,text,tokens} html{text}.
// Text keeps named entities (&amp;) and soft line breaks; both are resolved here.

import { getDefaults, lexer } from "../vendor/marked.esm.js";
import { normalize } from "./paths.js";

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" ? v : "");
const list = (v) => (Array.isArray(v) ? v : []);

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0", copy: "©", reg: "®", trade: "™",
  hellip: "…", mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", laquo: "«",
  raquo: "»", middot: "·", bull: "•", deg: "°", times: "×", divide: "÷", plusmn: "±", larr: "←",
  rarr: "→", uarr: "↑", darr: "↓", harr: "↔", euro: "€", pound: "£", yen: "¥", cent: "¢", sect: "§",
  para: "¶", shy: "\u00ad", ensp: "\u2002", emsp: "\u2003", thinsp: "\u2009",
};

/** Text with HTML character references resolved; unknown names stay as written. */
function decode(text) {
  return str(text).replace(/&(#[xX][0-9a-fA-F]{1,6}|#[0-9]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});/g, (whole, ref) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "\ufffd";
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, ref) ? ENTITIES[ref] : whole;
  });
}

/** djb2 of the token's raw text, as hex. */
export function blockKey(raw) {
  const s = str(raw);
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}

/** A heading anchor: lower-case, each space "-", only letters, digits, "-" and "_" kept. */
export function slug(text) {
  return str(text).toLowerCase().replace(/ /g, "-").replace(/[^\p{L}\p{N}_-]/gu, "");
}

function textRun(text, style) {
  const run = { type: "text", text };
  if (style.bold) run.bold = true;
  if (style.italic) run.italic = true;
  if (style.strike) run.strike = true;
  if (style.code) run.code = true;
  return run;
}

const sameStyle = (a, b) => a.bold === b.bold && a.italic === b.italic && a.strike === b.strike && a.code === b.code;

/** Adjacent text runs with the same style joined; a soft line break is a space. */
function tidy(runs) {
  const out = [];
  for (const run of runs) {
    if (run.type === "text") {
      const text = run.code ? run.text.replace(/\n/g, " ") : run.text.replace(/[ \t]*\n[ \t]*/g, " ");
      if (text === "") continue;
      const last = out[out.length - 1];
      if (last?.type === "text" && sameStyle(last, run)) {
        out[out.length - 1] = { ...last, text: last.text + text };
        continue;
      }
      out.push({ ...run, text });
    } else out.push(run);
  }
  return out;
}

function collect(tokens, style, out) {
  for (const tok of list(tokens)) {
    if (!isPlain(tok)) continue;
    switch (tok.type) {
      case "text":
        if (Array.isArray(tok.tokens) && tok.tokens.length) collect(tok.tokens, style, out);
        else out.push(textRun(decode(tok.text), style));
        break;
      case "escape":
        out.push(textRun(str(tok.text), style));
        break;
      case "strong":
        collect(tok.tokens, { ...style, bold: true }, out);
        break;
      case "em":
        collect(tok.tokens, { ...style, italic: true }, out);
        break;
      case "del":
        collect(tok.tokens, { ...style, strike: true }, out);
        break;
      case "codespan":
        out.push(textRun(str(tok.text), { ...style, code: true }));
        break;
      case "br":
        out.push({ type: "br" });
        break;
      case "link":
        out.push({ type: "link", href: str(tok.href), title: typeof tok.title === "string" ? decode(tok.title) : null, inlines: inlines(tok.tokens, style) });
        break;
      case "image":
        out.push({ type: "image", src: str(tok.href), alt: Array.isArray(tok.tokens) ? plain(inlines(tok.tokens, {})) : decode(tok.text), title: typeof tok.title === "string" ? decode(tok.title) : null });
        break;
      case "html":
        // Inline tags are not drawn; their text between them stays. <br> is a line break.
        if (/^<br\s*\/?>$/i.test(str(tok.text).trim())) out.push({ type: "br" });
        break;
      default:
        if (Array.isArray(tok.tokens)) collect(tok.tokens, style, out);
        else if (typeof tok.text === "string") out.push(textRun(decode(tok.text), style));
    }
  }
  return out;
}

function inlines(tokens, style = {}) {
  return tidy(collect(tokens, style, []));
}

/** The plain text of inline runs (links and images by their text). */
function plain(runs) {
  return runs.map((r) => (r.type === "text" ? r.text : r.type === "link" ? plain(r.inlines) : r.type === "image" ? r.alt : " ")).join("");
}

/** Heading ids are unique in one tree: repeats get "-1", "-2", … (as GitHub does). */
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

const langOf = (lang) => {
  const word = str(lang).trim().split(/\s+/)[0] ?? "";
  return word === "" ? null : word;
};

function block(tok, ids) {
  if (!isPlain(tok)) return null;
  const key = blockKey(tok.raw);
  switch (tok.type) {
    case "space":
    case "def":
    case "checkbox":
      return null;
    case "heading": {
      const runs = inlines(tok.tokens);
      const depth = Number.isInteger(tok.depth) ? Math.min(6, Math.max(1, tok.depth)) : 1;
      return { type: "heading", key, depth, id: uniqueId(slug(plain(runs)), ids), inlines: runs };
    }
    case "paragraph":
    case "text":
      return { type: "paragraph", key, inlines: Array.isArray(tok.tokens) ? inlines(tok.tokens) : tidy([textRun(decode(tok.text), {})]) };
    case "list":
      return {
        type: "list",
        key,
        ordered: tok.ordered === true,
        start: tok.ordered === true && Number.isInteger(tok.start) ? tok.start : null,
        items: list(tok.items).filter(isPlain).map((item) => ({ task: item.task === true, checked: item.task === true && item.checked === true, blocks: blocks(item.tokens, ids) })),
      };
    case "blockquote":
      return { type: "blockquote", key, blocks: blocks(tok.tokens, ids) };
    case "code":
      return { type: "code", key, lang: langOf(tok.lang), text: str(tok.text) };
    case "table":
      return {
        type: "table",
        key,
        align: list(tok.align).map((a) => (typeof a === "string" ? a : null)),
        header: list(tok.header).map((cell) => inlines(cell?.tokens)),
        rows: list(tok.rows).map((row) => list(row).map((cell) => inlines(cell?.tokens))),
      };
    case "hr":
      return { type: "hr", key };
    case "html":
      return { type: "html", key, text: str(tok.text) };
    default:
      if (Array.isArray(tok.tokens)) return { type: "paragraph", key, inlines: inlines(tok.tokens) };
      if (typeof tok.text === "string" && tok.text !== "") return { type: "paragraph", key, inlines: tidy([textRun(decode(tok.text), {})]) };
      return null;
  }
}

function blocks(tokens, ids) {
  const out = [];
  for (const tok of list(tokens)) {
    const b = block(tok, ids);
    if (b) out.push(b);
  }
  return out;
}

/** marked's block tokens → the render tree. */
export function toTree(tokens) {
  return blocks(tokens, new Map());
}

/** Markdown text → the render tree, lexed with the vendored marked (gfm). */
export function parse(text) {
  let tokens;
  try {
    tokens = lexer(str(text), { ...getDefaults(), gfm: true });
  } catch {
    return [];
  }
  return toTree(tokens);
}

function unescape(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Where a Markdown link goes: an http(s) URL, an anchor in this file, a local file (normalized
 *  against `baseDir`, with its anchor), or something else (mailto:, other schemes, empty). */
export function resolveLink(href, baseDir) {
  const h = str(href).trim();
  if (h === "") return { kind: "other" };
  if (/^https?:\/\//i.test(h)) return { kind: "url", url: h };
  if (h.startsWith("#")) return { kind: "anchor", anchor: unescape(h.slice(1)) };
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(h)) return { kind: "other" };
  const hash = h.indexOf("#");
  const target = hash < 0 ? h : h.slice(0, hash);
  const anchor = hash < 0 || hash === h.length - 1 ? null : unescape(h.slice(hash + 1));
  const query = target.indexOf("?");
  const path = unescape(query < 0 ? target : target.slice(0, query));
  if (path === "") return anchor === null ? { kind: "other" } : { kind: "anchor", anchor };
  return { kind: "file", path: normalize(path.startsWith("/") ? path : `${str(baseDir)}/${path}`), anchor };
}
