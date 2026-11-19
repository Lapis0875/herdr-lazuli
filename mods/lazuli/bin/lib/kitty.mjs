// Terminal helpers for the HTML viewer (bin/html-view.mjs): its Herdr terminal label, the modes it
// turns on, Kitty graphics (Herdr terminals decode PNG only, spike S1), terminal cell widths, safe
// display text, and one input parser for what comes back: text, keys (legacy and kitty keyboard
// `CSI … u`), SGR mouse (1006/1016), bracketed paste (2004), focus (1004), DECRPM mode replies, cell
// size (`CSI 6;h;w t`) and the background colour (OSC 11). Modeled on H/bin/herdr-browser-view.

import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";

/** Sets one `key=value` label on this Herdr terminal (`hc label $HC_TERMINAL_ID`, hc from PATH or
 *  ~/.local/bin). Skipped outside a Herdr terminal; failures are ignored. */
export function labelTerminal(label, env = process.env) {
  if (!env.HC_TERMINAL_ID) return;
  const args = ["label", env.HC_TERMINAL_ID, label];
  execFile("hc", args, { timeout: 10000 }, (e) => {
    if (e?.code === "ENOENT") execFile(path.join(os.homedir(), ".local", "bin", "hc"), args, { timeout: 10000 }, () => {});
  });
}

/** Alternate screen, no cursor, no autowrap, all-motion SGR mouse, focus and paste reports, kitty
 *  keyboard flag 1, pixel mouse (1016) plus a DECRQM asking whether it took, the cell size, and
 *  the background colour. */
export function setupSequence() {
  return (
    "\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[2J" +
    "\x1b[?1003h\x1b[?1006h\x1b[?1004h\x1b[?2004h\x1b[>1u" +
    "\x1b[?1016h\x1b[?1016$p" +
    "\x1b[16t" +
    "\x1b]11;?\x1b\\"
  );
}

/** Undoes setupSequence and deletes every image. */
export function restoreSequence() {
  return DELETE_IMAGES + "\x1b[<u\x1b[?2004l\x1b[?1004l\x1b[?1016l\x1b[?1006l\x1b[?1003l\x1b[?7h\x1b[?25h\x1b[?1049l";
}

/** Sets the terminal title (OSC 2 and OSC 0); unsafe characters (see safeText) are dropped. */
export function titleSequence(title) {
  const t = String(title).replace(UNSAFE, "");
  return `\x1b]2;${t}\x07\x1b]0;${t}\x07`;
}

// C0 and C1 controls (ESC among them), DEL, and the bidi marks, embeddings, overrides and isolates
// that would reorder what follows them on the line.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Text from an untrusted source (page URLs, console errors, dialog messages), safe to write to the
 *  terminal: tabs and line breaks become spaces, every other unsafe character "\uFFFD". */
export function safeText(s) {
  return String(s ?? "").replace(UNSAFE, (c) => (c === "\t" || c === "\n" || c === "\r" ? " " : "\uFFFD"));
}

/** Deletes every image placement of this terminal, quietly. */
export const DELETE_IMAGES = "\x1b_Ga=d,d=A,q=2\x1b\\";

/** One PNG (base64) as image `id`, placement `placement`, scaled over `cols`×`rows` cells from
 *  0-based (`col`, `row`); transmitting the same id again replaces it in place. The cursor is
 *  saved and restored around it. */
export function imageSequence(b64, { col, row, cols, rows, id = 1, placement = 1, chunk = 4096 }) {
  const parts = [`\x1b7\x1b[${row + 1};${col + 1}H`];
  for (let i = 0; i < b64.length; i += chunk) {
    const data = b64.slice(i, i + chunk);
    const more = i + chunk < b64.length ? 1 : 0;
    parts.push(
      i === 0
        ? `\x1b_Ga=T,f=100,t=d,i=${id},p=${placement},q=2,C=1,z=-1,c=${cols},r=${rows},m=${more};${data}\x1b\\`
        : `\x1b_Gm=${more};${data}\x1b\\`,
    );
  }
  parts.push("\x1b8");
  return parts.join("");
}

/** Terminal columns of one code point: 0 for controls and combining marks, 2 for East Asian wide
 *  and emoji ranges, else 1. */
export function charWidth(cp) {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || cp === 0x200b || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if ((cp >= 0x1160 && cp <= 0x11ff) || (cp >= 0xd7b0 && cp <= 0xd7ff)) return 0; // Hangul jungseong/jongseong
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
    (cp >= 0xa960 && cp <= 0xa97f) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

/** Terminal columns of a string. */
export function textWidth(s) {
  let w = 0;
  for (const ch of String(s)) w += charWidth(ch.codePointAt(0));
  return w;
}

/** `s` made safe (safeText), then cut to `max` columns, keeping its start and ending in "…" when cut. */
export function fitEnd(s, max) {
  s = safeText(s);
  if (max <= 0) return "";
  if (textWidth(s) <= max) return s;
  let w = 0, outStr = "";
  for (const ch of s) {
    const cw = charWidth(ch.codePointAt(0));
    if (w + cw > max - 1) break;
    outStr += ch;
    w += cw;
  }
  return outStr + "…";
}

/** `s` made safe (safeText), then cut to `max` columns, keeping its end and starting with "…" when
 *  cut (for paths). */
export function fitStart(s, max) {
  s = safeText(s);
  if (max <= 0) return "";
  if (textWidth(s) <= max) return s;
  const chars = Array.from(s);
  let w = 0, i = chars.length;
  while (i > 0) {
    const cw = charWidth(chars[i - 1].codePointAt(0));
    if (w + cw > max - 1) break;
    w += cw;
    i--;
  }
  return "…" + chars.slice(i).join("");
}

/** Kitty-style modifiers (1 + bits) → flags. */
export function modBits(m = 1) {
  const bits = Math.max(0, (Number(m) || 1) - 1);
  return { shift: !!(bits & 1), alt: !!(bits & 2), ctrl: !!(bits & 4), meta: !!(bits & 8) };
}

// The Korean 2-set (dubeolsik) layout as letter–jamo pairs: what each QWERTY key types with the
// Korean input source on; with Shift, the upper-case keys type the doubled consonants and ㅒ ㅖ.
const DUBEOLSIK = "qㅂwㅈeㄷrㄱtㅅyㅛuㅕiㅑoㅐpㅔaㅁsㄴdㅇfㄹgㅎhㅗjㅓkㅏlㅣzㅋxㅌcㅊvㅍbㅠnㅜmㅡQㅃWㅉEㄸRㄲTㅆOㅒPㅖ";
const LATIN = new Map(Array.from({ length: DUBEOLSIK.length / 2 }, (_, i) => [DUBEOLSIK[2 * i + 1], DUBEOLSIK[2 * i]]));

/** The QWERTY letter of a key that came as a 2-set jamo (`ㅛ` → "y", `ㄲ` → "R"), so the viewer's
 *  letter keys work with the Korean input source on; any other key unchanged. */
export function latinKey(k) {
  return LATIN.get(k) ?? k;
}

const KITTY_CODE = { 13: "Enter", 9: "Tab", 127: "Backspace", 8: "Backspace", 27: "Escape" };
const CSI_LETTER = { A: "ArrowUp", B: "ArrowDown", C: "ArrowRight", D: "ArrowLeft", H: "Home", F: "End", P: "F1", Q: "F2", R: "F3", S: "F4" };
const CSI_TILDE = { 1: "Home", 2: "Insert", 3: "Delete", 4: "End", 5: "PageUp", 6: "PageDown", 7: "Home", 8: "End", 11: "F1", 12: "F2", 13: "F3", 14: "F4", 15: "F5", 17: "F6", 18: "F7", 19: "F8", 20: "F9", 21: "F10", 23: "F11", 24: "F12" };
const MAX_PENDING = 8 << 20;

/** Parses terminal input into events passed to `emit`:
 *  `{type:"text", text}` (a run of printable characters), `{type:"key", key, mods}` (`key` is a
 *  DOM key name or one character, `mods` kitty-style 1 + bits), `{type:"mouse", b, x, y, release}`
 *  (SGR, 1-based), `{type:"paste", text}`, `{type:"focus", focused}`, `{type:"mode", mode, state}`,
 *  `{type:"cell", w, h}`, `{type:"area", w, h}`, `{type:"bg", r, g, b}` (0..1).
 *  A lone Escape is told apart from a sequence still arriving after `escapeDelayMs`. */
export function createInputParser(emit, { escapeDelayMs = 40 } = {}) {
  const decoder = new StringDecoder("utf8");
  let buf = "";
  let timer = null;
  const key = (k, mods = 1) => emit({ type: "key", key: k, mods });

  function push(chunk) {
    buf += typeof chunk === "string" ? chunk : decoder.write(chunk);
    run();
  }

  function wait() {
    timer = setTimeout(() => {
      timer = null;
      if (buf === "\x1b") {
        buf = "";
        key("Escape");
      } else if (buf.startsWith("\x1b")) {
        buf = buf.slice(1);
        run();
      }
    }, escapeDelayMs);
  }

  function run() {
    clearTimeout(timer);
    timer = null;
    while (buf.length) {
      const c0 = buf.charCodeAt(0);
      if (c0 !== 0x1b) {
        let i = 0;
        while (i < buf.length) {
          const c = buf.charCodeAt(i);
          if (c < 32 || c === 0x7f) break;
          i++;
        }
        if (i > 0) {
          emit({ type: "text", text: buf.slice(0, i) });
          buf = buf.slice(i);
          continue;
        }
        buf = buf.slice(1);
        if (c0 === 13 || c0 === 10) key("Enter");
        else if (c0 === 9) key("Tab");
        else if (c0 === 0x7f || c0 === 8) key("Backspace");
        else if (c0 === 0) key(" ", 5);
        else if (c0 <= 26) key(String.fromCharCode(c0 + 96), 5);
        else key(String.fromCharCode(c0 + 64), 5);
        continue;
      }
      if (buf.length === 1) return wait();
      const c1 = buf[1];
      if (c1 === "[") {
        if (buf.startsWith("\x1b[200~")) {
          const end = buf.indexOf("\x1b[201~");
          if (end < 0) {
            if (buf.length > MAX_PENDING) {
              emit({ type: "paste", text: buf.slice(6) });
              buf = "";
            }
            return;
          }
          emit({ type: "paste", text: buf.slice(6, end) });
          buf = buf.slice(end + 6);
          continue;
        }
        const m = /^\x1b\[([\x30-\x3f]*)([\x20-\x2f]*)([\x40-\x7e])/.exec(buf);
        if (!m) {
          if (buf.length < 64 && /^\x1b\[[\x20-\x3f]*$/.test(buf)) return wait();
          buf = buf.slice(2);
          continue;
        }
        buf = buf.slice(m[0].length);
        csi(m[1], m[2], m[3]);
        continue;
      }
      if (c1 === "]" || c1 === "_" || c1 === "P" || c1 === "^") {
        const st = buf.indexOf("\x1b\\", 2);
        const bel = c1 === "]" ? buf.indexOf("\x07", 2) : -1;
        const end = bel >= 0 && (st < 0 || bel < st) ? { at: bel, len: 1 } : st >= 0 ? { at: st, len: 2 } : null;
        if (!end) {
          if (buf.length > MAX_PENDING) buf = "";
          return;
        }
        const body = buf.slice(2, end.at);
        buf = buf.slice(end.at + end.len);
        if (c1 === "]") osc(body);
        continue;
      }
      if (c1 === "O") {
        if (buf.length < 3) return wait();
        const f = buf[2];
        buf = buf.slice(3);
        if (CSI_LETTER[f]) key(CSI_LETTER[f]);
        continue;
      }
      const ch = String.fromCodePoint(buf.codePointAt(1));
      buf = buf.slice(1 + ch.length);
      const cc = ch.charCodeAt(0);
      if (ch === "\x1b") key("Escape", 3);
      else if (cc === 13) key("Enter", 3);
      else if (cc === 0x7f || cc === 8) key("Backspace", 3);
      else if (cc >= 32) key(ch, 3);
    }
  }

  function csi(params, inter, fin) {
    if (params.startsWith("<") && (fin === "M" || fin === "m")) {
      const [b, x, y] = params.slice(1).split(";").map(Number);
      if ([b, x, y].every(Number.isFinite)) emit({ type: "mouse", b, x, y, release: fin === "m" });
      return;
    }
    if (params.startsWith("?")) {
      if (inter === "$" && fin === "y") {
        const [mode, state] = params.slice(1).split(";").map(Number);
        emit({ type: "mode", mode, state });
      }
      return;
    }
    if (inter || /[^\d;:]/.test(params)) return;
    if (fin === "t") {
      const [k, h, w] = params.split(";").map(Number);
      if (k === 6 && h > 0 && w > 0) emit({ type: "cell", w, h });
      else if (k === 4 && h > 0 && w > 0) emit({ type: "area", w, h });
      return;
    }
    if (!params && (fin === "I" || fin === "O")) {
      emit({ type: "focus", focused: fin === "I" });
      return;
    }
    const p = params.split(";").map((x) => x.split(":")[0]);
    const mods = Number(p[1] || 1) || 1;
    if (fin === "u") {
      const code = Number(p[0]);
      const k = KITTY_CODE[code] ?? (code >= 32 && !(code >= 0xe000 && code <= 0xf8ff) ? String.fromCodePoint(code) : null);
      if (k) key(k, mods);
      return;
    }
    if (fin === "~") {
      const k = CSI_TILDE[Number(p[0])];
      if (k) key(k, mods);
      return;
    }
    if (fin === "Z") {
      key("Tab", 2);
      return;
    }
    if (CSI_LETTER[fin]) key(CSI_LETTER[fin], mods);
  }

  function osc(body) {
    const m = /^11;rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})/i.exec(body);
    if (!m) return;
    const v = (h) => parseInt(h, 16) / (16 ** h.length - 1);
    emit({ type: "bg", r: v(m[1]), g: v(m[2]), b: v(m[3]) });
  }

  return { push };
}
