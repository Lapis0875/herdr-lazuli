// Where a Review comment's line is (views/diff.js): a diff line is `[kind, old, new, text, marks?]` (kind "@" hunk
// header, "+", "-", " ", "!" note). A comment keeps the line it is about as an anchor: path, side, number, the code
// it quotes and the lines around it; a refreshed diff finds it again only by that, never by list positions.

/** How far (in line numbers) a refreshed diff is searched for a comment's line that moved. */
const NEAR = 40;

/** A line's number on its side: the old number for a removed line, else the new one. */
export const lineNo = (line) => (line[0] === "-" ? line[1] : line[2] ?? line[1]);
/** A line's text. */
export const codeOf = (line) => String(line?.[3] ?? "");
/** "old" for a removed line, "new" for an added or context line, null for a hunk header or note. */
export const sideOf = (ln) => (ln[0] === "-" ? "old" : ln[0] === "+" || ln[0] === " " ? "new" : null);

/** The text of the lines just above and below line `i` (null at a hunk edge). */
export function neighbors(lines, i) {
  const at = (j) => (lines[j] && lines[j][0] !== "@" && lines[j][0] !== "!" ? codeOf(lines[j]) : null);
  return [at(i - 1), at(i + 1)];
}

/** The anchor of line `l` in `file`: what a comment on it keeps. */
export function anchorAt(file, l) {
  const line = file.lines[l];
  const [before, after] = neighbors(file.lines, l);
  return { path: file.path, line: lineNo(line), old: line[0] === "-", code: codeOf(line), before, after };
}

/**
 * Where an anchored line is in a refreshed file, or -1. The line must be on the same side (removed, or
 * new/context) and hold exactly the code the anchor quotes, within NEAR line numbers. At its own number it is
 * taken when nothing around it contradicts what was saved (a blank line needs its saved neighbours to match).
 * Otherwise, including when its own number's neighbours changed, exactly one line whose neighbours match what was
 * around it must exist; none or several (ambiguous) leave the comment stale rather than quoting the wrong code.
 */
export function anchorOf(file, c) {
  const want = c.old ? "old" : "new";
  const blank = !String(c.code ?? "").trim();
  const context = (i) => {
    const [b, a] = neighbors(file.lines, i);
    return [[c.before, b], [c.after, a]].filter(([was]) => was != null).map(([was, now]) => was === now);
  };
  // `agrees`: no saved neighbour disagrees; `fits`: at least one saved neighbour and all of them match.
  const agrees = (i) => context(i).every(Boolean);
  const fits = (i) => {
    const seen = context(i);
    return seen.length > 0 && seen.every(Boolean);
  };
  const same = [];
  file.lines.forEach((ln, i) => {
    if (sideOf(ln) !== want || codeOf(ln) !== c.code) return;
    const d = Math.abs((lineNo(ln) ?? Infinity) - c.line);
    if (d <= NEAR) same.push({ i, d });
  });
  const exact = same.find((h) => h.d === 0);
  if (exact && (blank ? fits(exact.i) : agrees(exact.i))) return exact.i;
  const placed = same.filter((h) => fits(h.i));
  return placed.length === 1 ? placed[0].i : -1;
}
