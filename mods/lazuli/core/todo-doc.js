// The to-do file (ARCHITECTURE §4.5): Markdown whose `- [ ] text` and `- [x] text` lines are the items. Every other
// line, and every item line no edit touched, is written back exactly as it was read.
//
// A port of cockpit v0.38.5 `herdr/tui/todo/src/doc.rs`. Rust's `str::trim`, `\s` and `\d` are Unicode-aware, so
// they are kept here as `\p{White_Space}` and `\p{Nd}`; Rust's `.` matches everything but `\n`, which a line never
// holds, hence the `s` flag. `links` is lazuli's: URLs as upstream, plus GitHub issue and PR references.

const ITEM = /^- \[( |x)\] (.*)$/su;
const DONE_ON = /\p{White_Space}*\(done \p{Nd}{4}-\p{Nd}{2}-\p{Nd}{2}\)$/u;
const EDGES = /^\p{White_Space}+|\p{White_Space}+$/gu;
const NEWLINES = /[\r\n]+/g;
const SLUG = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
// A URL (upstream's `https?://\S+`, any case); `owner/repo#n` not inside a path or a word; `#n` alone.
const TOKEN = /(https?:\/\/[^\p{White_Space}]+)|(?<![\w./#-])([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)#([0-9]+)(?!\w)|(?<![\w/#&])#([0-9]+)(?!\w)/giu;

/** What a new file starts with. */
export const NEW_FILE = "# To-do\n\n";

const trim = (s) => s.replace(EDGES, "");
const linesOf = (doc) => (doc !== null && typeof doc === "object" && Array.isArray(doc.lines) ? doc.lines : []);
const isLine = (lines, n) => Number.isInteger(n) && n >= 0 && n < lines.length;
const lineOf = (done, text) => `- [${done ? "x" : " "}] ${text}`;

/** The item a line holds, the line read without the spaces around it: `{done, text}` or null. */
function itemOf(raw) {
  if (typeof raw !== "string") return null;
  const found = ITEM.exec(trim(raw));
  return found ? { done: found[1] === "x", text: found[2] } : null;
}

/** The file split on newlines: a file ending with one has an empty last line. */
export function parse(text) {
  return { lines: (typeof text === "string" ? text : "").split("\n") };
}

/** The file's text: the lines joined with newlines. */
export function text(doc) {
  return linesOf(doc).join("\n");
}

/** The items in file order. */
export function items(doc) {
  const out = [];
  linesOf(doc).forEach((raw, line) => {
    const item = itemOf(raw);
    if (item) out.push({ line, done: item.done, text: item.text });
  });
  return out;
}

/** A new open item at the top of the list; with no items, after the heading, before the empty line that ends the
 *  file. Newlines in `text` become one space; empty after trimming → the same doc. */
export function add(doc, text) {
  const clean = trim((typeof text === "string" ? text : "").replace(NEWLINES, " "));
  if (clean === "") return doc;
  const lines = linesOf(doc);
  const first = items(doc)[0];
  const at = first ? first.line : lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  const next = lines.slice();
  next.splice(at, 0, lineOf(false, clean));
  return { lines: next };
}

/** The line rewritten as an item (its indentation lost, as upstream); the others keep their place. */
export function set(doc, line, done, text) {
  const lines = linesOf(doc);
  if (!isLine(lines, line)) return doc;
  const next = lines.slice();
  next[line] = lineOf(done, typeof text === "string" ? text : "");
  return { lines: next };
}

/** The line taken out. */
export function remove(doc, line) {
  const lines = linesOf(doc);
  if (!isLine(lines, line)) return doc;
  const next = lines.slice();
  next.splice(line, 1);
  return { lines: next };
}

/** The line at `from` moved to take the place of the line at `to`, the lines between shifting by one. */
export function place(doc, from, to) {
  const lines = linesOf(doc);
  if (!isLine(lines, from) || !isLine(lines, to) || from === to) return doc;
  const next = lines.slice();
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return { lines: next };
}

/** Open items first, done ones after, each kept in its order, in the lines the items already take. */
export function order(doc) {
  const lines = linesOf(doc);
  const list = items(doc);
  const raws = [...list.filter((i) => !i.done), ...list.filter((i) => i.done)].map((i) => lines[i.line]);
  const next = lines.slice();
  list.forEach((item, n) => {
    next[item.line] = raws[n];
  });
  return { lines: next };
}

/** An item done or open again: the date it was done on (`today`, "YYYY-MM-DD") added or taken off, the list ordered
 *  again. A line that is not an item → the same doc. */
export function toggle(doc, line, today) {
  const item = items(doc).find((i) => i.line === line);
  if (!item) return doc;
  const plain = undated(item.text);
  return order(set(doc, line, !item.done, item.done ? plain : `${plain} (done ${today})`));
}

/** The text without the " (done YYYY-MM-DD)" a toggle adds. */
export function undated(text) {
  if (typeof text !== "string") return text;
  const found = DONE_ON.exec(text);
  return found ? text.slice(0, found.index) : text;
}

/** The links in an item's text, in order: URLs; `owner/repo#n`; with `repo` ("owner/name"), `#n`. References lead to
 *  `https://github.com/<slug>/issues/<n>`, which GitHub forwards to a pull request of that number. */
export function links(text, o) {
  if (typeof text !== "string") return [];
  const repo = typeof o?.repo === "string" && SLUG.test(o.repo) ? o.repo : null;
  const out = [];
  for (const found of text.matchAll(TOKEN)) {
    if (found[1]) out.push({ kind: "url", label: found[1], url: found[1] });
    else if (found[2]) out.push({ kind: "ref", label: found[0], url: `https://github.com/${found[2]}/issues/${found[3]}` });
    else if (repo) out.push({ kind: "ref", label: found[0], url: `https://github.com/${repo}/issues/${found[4]}` });
  }
  return out;
}
