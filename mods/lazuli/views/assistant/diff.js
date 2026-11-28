// A line diff of an ACP `diff` content block (`{path, oldText, newText}`; `oldText` absent for a new file), drawn by
// the tool and approval cards as unified hunks with three lines of context. Pure. Large inputs stay cheap: the common
// head and tail are cut first, Myers runs only on the rest and only up to MAX_D edits (above that the rest reads as
// removed then added), and at most `maxLines` lines are returned, with the count of the ones left out.

const CONTEXT = 3;
const MAX_D = 400;
const MAX_MIDDLE = 6000;

const linesOf = (text) => {
  if (typeof text !== "string" || text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
};

/** Myers' shortest edit script between `a` and `b` (line arrays) as ops `[" "|"-"|"+", line]`, or null past `maxD`
 *  edits. Each step keeps only the diagonals it reached, so memory grows with D², not with the input. */
function myers(a, b, maxD) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  const trace = [];
  for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push({ base: off - d - 1, arr: v.slice(off - d - 1, off + d + 2) });
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) return backtrack(a, b, trace, off);
    }
  }
  return null;
}

function backtrack(a, b, trace, off) {
  const ops = [];
  let x = a.length;
  let y = b.length;
  for (let d = trace.length - 1; d >= 0; d--) {
    const { base, arr } = trace[d];
    const at = (k) => arr[off + k - base];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push([" ", a[x - 1]]);
      x--;
      y--;
    }
    if (d > 0) {
      if (x === prevX) ops.push(["+", b[y - 1]]);
      else ops.push(["-", a[x - 1]]);
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

/** The diff of two texts: `{add, remove, lines: [[sign, text]], more}`. `sign` is " ", "-", "+" or "@" (a hunk header,
 *  `@@ -start,len +start,len @@`). `more` is how many lines were left out after `maxLines`. */
export function lineDiff(oldText, newText, { maxLines = 400 } = {}) {
  const a = linesOf(oldText);
  const b = linesOf(newText);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const middle =
    (midA.length + midB.length <= MAX_MIDDLE ? myers(midA, midB, MAX_D) : null) ??
    [...midA.map((l) => ["-", l]), ...midB.map((l) => ["+", l])];
  const ops = [...a.slice(0, head).map((l) => [" ", l]), ...middle, ...a.slice(a.length - tail).map((l) => [" ", l])];
  let add = 0;
  let remove = 0;
  for (const [s] of ops) {
    if (s === "+") add++;
    else if (s === "-") remove++;
  }
  const lines = [];
  // Hunks: every change with CONTEXT equal lines around it; runs closer than twice that merge.
  let i = 0;
  let oldNo = 1;
  let newNo = 1;
  const pos = ops.map(([s]) => {
    const p = [oldNo, newNo];
    if (s !== "+") oldNo++;
    if (s !== "-") newNo++;
    return p;
  });
  while (i < ops.length) {
    while (i < ops.length && ops[i][0] === " ") i++;
    if (i >= ops.length) break;
    const start = Math.max(0, i - CONTEXT);
    let end = i;
    for (;;) {
      while (end < ops.length && ops[end][0] !== " ") end++;
      let eq = end;
      while (eq < ops.length && ops[eq][0] === " ") eq++;
      if (eq < ops.length && eq - end <= CONTEXT * 2) end = eq;
      else {
        end = Math.min(ops.length, end + CONTEXT);
        break;
      }
    }
    const hunk = ops.slice(start, end);
    const oldLen = hunk.filter(([s]) => s !== "+").length;
    const newLen = hunk.filter(([s]) => s !== "-").length;
    lines.push(["@", `@@ -${oldLen ? pos[start][0] : pos[start][0] - 1},${oldLen} +${newLen ? pos[start][1] : pos[start][1] - 1},${newLen} @@`]);
    lines.push(...hunk);
    i = end;
  }
  const shown = lines.slice(0, maxLines);
  return { add, remove, lines: shown, more: lines.length - shown.length };
}
