// The HTML viewer's input forwarding: terminal mouse, wheel, keys, text and paste (the events of
// kitty.mjs's parser) → CDP Input events on the shown page. Plain ASCII goes as key events so pages
// listening for keys get them; other text (Hangul included) through Input.insertText. The viewer's
// own keys: Ctrl+R/F5 reload, Alt+←/→ history, Ctrl+V pastes the desktop clipboard, Ctrl+C copies
// the page's selection to it. A key with Ctrl, Alt or ⌘ that comes as a Korean 2-set jamo counts as
// its QWERTY letter (Ctrl+ㄱ is Ctrl+R), for these keys and the page's own shortcuts.
// Modeled on H/bin/herdr-browser-view.

import { execFile, spawn } from "node:child_process";
import { latinKey, modBits } from "./kitty.mjs";

const MOVE_MS = 33;
const WHEEL_PX = 60;
const BUTTONS = ["left", "middle", "right"];
const HELD = { left: 1, right: 2, middle: 4 };
const CDP_MODS = (shift, alt, ctrl, meta) => (alt ? 1 : 0) | (ctrl ? 2 : 0) | (meta ? 4 : 0) | (shift ? 8 : 0);

// Chrome's key codes for the keys that type nothing.
const SPECIAL = {
  Enter: 13, Tab: 9, Backspace: 8, Escape: 27, Delete: 46, Insert: 45, Home: 36, End: 35, PageUp: 33, PageDown: 34,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117, F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
};

const SELECTION_JS = `(() => { const a = document.activeElement;
  if (a && (a.tagName === "TEXTAREA" || (a.tagName === "INPUT" && /^(text|search|url|tel|email)$/i.test(a.type))) && a.selectionStart !== a.selectionEnd)
    return a.value.slice(a.selectionStart, a.selectionEnd);
  return String(getSelection() ?? ""); })()`;

/** `o` gives the page and the picture:
 *  - `fire(method, params)`: a CDP call to the page, failures ignored; `evaluate(expression)` → its value.
 *  - `live()`: a page is attached and shown.
 *  - `view()`: `{cellW, cellH, pixelMouse, rect, page, buttons}`; `rect` is the picture in terminal
 *    pixels, `page` its CSS size, `buttons` the top line's `{row, x0, x1, fn}` (0-based cells).
 *  - `reload()`, `history(delta)`, `copied()`, `touched()` (the person acted on the page).
 *  Returns the handlers `{text, key, mouse, paste}` for the parser's events. */
export function createPageInput(o) {
  let down = null;
  let lastClick = { at: 0, x: 0, y: 0, n: 0 };
  let lastMove = 0;

  function toPage(v, px, py) {
    const r = v.rect;
    if (!r || !v.page || px < r.x || py < r.y || px >= r.x + r.w || py >= r.y + r.h) return null;
    return { x: Math.round(((px - r.x) / r.w) * v.page.w), y: Math.round(((py - r.y) / r.h) * v.page.h) };
  }

  function mouse(b, x, y, release) {
    const v = o.view();
    const cw = v.cellW || 9, ch = v.cellH || 18;
    // x, y: pixels from the top left (1016), else the cell's centre.
    const px = v.pixelMouse ? x - 1 : (x - 0.5) * cw, py = v.pixelMouse ? y - 1 : (y - 0.5) * ch;
    const motion = b & 32, wheel = b & 64, btn = b & 3;
    if (!motion && !wheel && !release) {
      const col = Math.floor(px / cw), row = Math.floor(py / ch);
      const hit = v.buttons.find((k) => k.row === row && col >= k.x0 && col < k.x1);
      if (hit) return hit.fn();
    }
    if (!o.live()) return undefined;
    const p = toPage(v, px, py);
    const modifiers = CDP_MODS(b & 4, b & 8, b & 16, false);
    const send = (params) => o.fire("Input.dispatchMouseEvent", { ...params, modifiers });
    if (wheel) {
      if (!p) return undefined;
      o.touched();
      const dx = btn === 2 ? -WHEEL_PX : btn === 3 ? WHEEL_PX : 0, dy = btn === 0 ? -WHEEL_PX : btn === 1 ? WHEEL_PX : 0;
      return send({ type: "mouseWheel", x: p.x, y: p.y, deltaX: dx, deltaY: dy });
    }
    if (motion) {
      if (!p || Date.now() - lastMove < MOVE_MS) return undefined;
      lastMove = Date.now();
      return send({ type: "mouseMoved", x: p.x, y: p.y, button: down ?? "none", buttons: down ? HELD[down] : 0 });
    }
    if (btn === 3 && !release) return undefined;
    if (!p) {
      if (release) down = null;
      return undefined;
    }
    o.touched();
    const button = release ? down ?? BUTTONS[btn] ?? "left" : BUTTONS[btn] ?? "left";
    if (!release) {
      const now = Date.now();
      const n = now - lastClick.at < 450 && Math.abs(lastClick.x - p.x) < 6 && Math.abs(lastClick.y - p.y) < 6 ? Math.min(lastClick.n + 1, 3) : 1;
      lastClick = { at: now, x: p.x, y: p.y, n };
      down = button;
    } else down = null;
    return send({ type: release ? "mouseReleased" : "mousePressed", x: p.x, y: p.y, button, buttons: release ? 0 : HELD[button], clickCount: lastClick.n });
  }

  function sendKey(k, f) {
    if (!o.live()) return;
    const modifiers = CDP_MODS(f.shift, f.alt, f.ctrl, f.meta);
    let keyDown;
    if (SPECIAL[k]) {
      const text = k === "Enter" && !f.ctrl && !f.alt && !f.meta ? "\r" : undefined;
      keyDown = { type: text ? "keyDown" : "rawKeyDown", key: k, code: k, windowsVirtualKeyCode: SPECIAL[k], ...(text ? { text, unmodifiedText: text } : {}) };
    } else if (Array.from(k).length === 1) {
      const code = /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : /^[0-9]$/.test(k) ? `Digit${k}` : k === " " ? "Space" : "";
      const vk = /^[a-z0-9]$/i.test(k) ? k.toUpperCase().charCodeAt(0) : k === " " ? 32 : 0;
      if (f.ctrl || f.alt || f.meta) {
        const l = k.toLowerCase();
        // Editing commands macOS Chrome takes only as commands (Ctrl stands in for ⌘ here).
        const command = f.ctrl && !f.alt ? (l === "a" ? "selectAll" : l === "x" ? "cut" : l === "z" ? (f.shift ? "redo" : "undo") : null) : null;
        keyDown = { type: "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, ...(command ? { commands: [command] } : {}) };
      } else keyDown = { type: "keyDown", key: k, code, windowsVirtualKeyCode: vk, text: k, unmodifiedText: k };
    } else return;
    o.fire("Input.dispatchKeyEvent", { ...keyDown, modifiers });
    o.fire("Input.dispatchKeyEvent", { type: "keyUp", key: keyDown.key, code: keyDown.code, windowsVirtualKeyCode: keyDown.windowsVirtualKeyCode, modifiers });
  }

  function insertText(text) {
    if (!text || !o.live()) return;
    o.touched();
    o.fire("Input.insertText", { text });
  }

  function pasteClipboard() {
    const [cmd, args] = process.platform === "darwin" ? ["pbpaste", []] : ["wl-paste", ["-n"]];
    execFile(cmd, args, { maxBuffer: 8 << 20 }, (e, so) => {
      if (!e && so) insertText(String(so));
    });
  }

  async function copySelection() {
    if (!o.live()) return;
    let text = "";
    try {
      text = String((await o.evaluate(SELECTION_JS)) ?? "");
    } catch {}
    if (!text) return;
    const p = spawn(process.platform === "darwin" ? "pbcopy" : "wl-copy", [], { stdio: ["pipe", "ignore", "ignore"] });
    p.on("error", () => {});
    p.stdin.on("error", () => {});
    p.on("exit", (code) => {
      if (code === 0) o.copied();
    });
    p.stdin.end(text);
  }

  function key(k, mods) {
    const f = modBits(mods);
    if (f.ctrl || f.alt || f.meta) k = latinKey(k);
    if (f.shift && !f.ctrl && !f.alt && !f.meta && /^[a-z]$/.test(k)) k = k.toUpperCase();
    const plainCtrl = f.ctrl && !f.alt && !f.shift;
    if ((plainCtrl && /^[rR]$/.test(k)) || k === "F5") return o.reload();
    if (f.alt && !f.ctrl && k === "ArrowLeft") return o.history(-1);
    if (f.alt && !f.ctrl && k === "ArrowRight") return o.history(1);
    if (plainCtrl && /^[vV]$/.test(k)) return pasteClipboard();
    if (plainCtrl && /^[cC]$/.test(k)) return copySelection();
    if (o.live()) o.touched();
    return sendKey(k, f);
  }

  function text(t) {
    if (!o.live()) return;
    o.touched();
    if (/^[\x20-\x7e]+$/.test(t)) for (const ch of t) sendKey(ch, {});
    else insertText(t);
  }

  return { text, key, mouse, paste: (t) => insertText(t.replace(/\r\n?/g, "\n")) };
}
