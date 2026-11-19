#!/usr/bin/env node
// lazuli's HTML viewer (DESIGN B7, B8; ARCHITECTURE §5): one HTML or Markdown file, live in a terminal
// pane beside its file tab, drawn by the shared headless Chrome (chrome-broker.mjs) over CDP directly.
// Modeled on H/bin/herdr-browser-view, without agent-browser.
//   node html-view.mjs --fid <id> --file <absolute path> --kind html|md [--lang ko|en] [--settings <path>]
// - Title `lazuli-view:<fid8>` (found in panes()); terminal label `lazuli.view=<fid>` (after a reboot).
// - Text in `--lang`, then live from settings.json (default: this install's app home; lib/language.mjs).
// - Pages from a loopback static server rooted at the git top-level, else the file's folder; Markdown
//   rendered at /__lazuli/md/<rel>. Each save reloads the page and puts the scroll position back.
// - Frames: Chrome's PNG screencast sized to the pane (SIGWINCH + `CSI 16t`), one Kitty image replaced
//   in place; the next frame is asked for only once this one is out, at most FPS a second.
// - Input (lib/page-input.mjs): pixel mouse, wheel, kitty keyboard, paste, Input.insertText; Ctrl+V
//   pastes (pbpaste), Ctrl+C copies (pbcopy), Ctrl+R/F5 reload, Alt+←/→ history.
// - Same-origin and in-page navigation stay; other http(s) pages open in the default browser.
// - Top line: path, reload, open in browser, console error count (click: the last error).
// Exits 0 on SIGHUP (pane closed) or SIGTERM, releasing its lease; 2 on bad arguments; 3 with the
// line "no-browser" when no supported browser is installed.

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import viewerEn from "../core/catalog/viewer.en.js";
import viewerKo from "../core/catalog/viewer.ko.js";
import { translate } from "../core/i18n.js";
import { connectCdp } from "./lib/cdp.mjs";
import { acquireLease, findBrowser } from "./lib/chrome.mjs";
import * as K from "./lib/kitty.mjs";
import { defaultSettingsPath, followLanguage } from "./lib/language.mjs";
import { createCast, viewFor } from "./lib/cast.mjs";
import { createDialogs } from "./lib/page-dialog.mjs";
import { createPageInput } from "./lib/page-input.mjs";
import { displayPath, findRoot, watchFile } from "./lib/source.mjs";
import { startStaticServer } from "./lib/static-server.mjs";

const FPS = 30;
const BROKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "chrome-broker.mjs");

const argv = process.argv.slice(2);
const opt = (k) => {
  const i = argv.indexOf(k);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
};
const FID = opt("--fid"), FILE = opt("--file"), KIND = opt("--kind");
let lang = opt("--lang") === "ko" ? "ko" : "en";
if (!FID || !FILE || !path.isAbsolute(FILE) || (KIND !== "html" && KIND !== "md")) {
  process.stderr.write("html-view --fid <id> --file <absolute path> --kind html|md [--lang ko|en] [--settings <path>]\n");
  process.exit(2);
}
fs.writeSync(1, K.titleSequence(`lazuli-view:${FID.slice(0, 8)}`));
if (!findBrowser()) {
  fs.writeSync(1, "no-browser\n");
  process.exit(3);
}
// The `lazuli.view` label outlives the title when the pane comes back as a bare shell.
K.labelTerminal(`lazuli.view=${FID}`);

const tr = (key, vars) => translate(lang, key, vars, { en: viewerEn, ko: viewerKo });
const HOME = os.homedir();
const out = process.stdout;
let quitting = false;
// Terminal output; once quitting, or when the pane is gone, nothing more is written.
const write = (s) => {
  try { return quitting || out.write(s); } catch { return true; }
};

const S = {
  phase: "starting", // starting | loading | live | restarting | error
  code: "",
  cols: out.columns || 80, rows: out.rows || 24,
  cellW: 0, cellH: 0, pixelMouse: false, dark: null,
  url: "", errors: 0, lastError: "", showError: false, missing: false,
  notice: "", noticeUntil: 0,
  page: null, rect: null, imgCells: null, drawn: false,
  buttons: [],
};
// The page connection; `gen` changes on every (re)attach so late events of an old one are ignored.
const V = {
  gen: 0, lease: null, cdp: null, session: null, targetId: null, mainFrame: null, navAt: 0, scroll: null, scrollTimers: [],
};
let server = null, ROOT = path.dirname(FILE), REL = path.basename(FILE);

const call = (method, params = {}) => (V.cdp ? V.cdp.call(method, params, V.session) : Promise.reject(new Error("no page")));
const fire = (method, params) => call(method, params).catch(() => {});
const sameOrigin = (url) => {
  try { return !!server && new URL(url).origin === server.origin; } catch { return false; }
};
const pageUrl = () => server.url(KIND === "md" ? `__lazuli/md/${REL}` : REL);
const shownUrl = () => (S.url && sameOrigin(S.url) ? S.url : pageUrl());
// confirm, prompt and beforeunload wait for Enter/Esc (or y/n) in the top line; an alert is reported.
const dialogs = createDialogs({ fire, changed: () => bar(), notice: (message) => note(tr("viewer.dialog", { message })) });

// ---- terminal ----

function quit(code = 0) {
  if (quitting) return;
  try { fs.writeSync(1, K.restoreSequence()); } catch {}
  quitting = true;
  try { V.cdp?.close(); } catch {}
  try { V.lease?.close(); } catch {}
  server?.close();
  process.exit(code);
}
for (const sig of ["SIGHUP", "SIGTERM", "SIGINT"]) process.on(sig, () => quit(0));
out.on("error", () => quit(0));
process.on("exit", () => {
  if (!quitting) try { fs.writeSync(1, K.restoreSequence()); } catch {}
});
process.on("uncaughtException", (e) => {
  S.lastError = String(e?.stack ?? e);
  setPhase("error", "internal");
});
process.on("unhandledRejection", (e) => (S.lastError = String(e?.stack ?? e)));

const areaRows = () => Math.max(1, S.rows - 1);
const areaPx = () => ({ w: S.cols * S.cellW, h: areaRows() * S.cellH });
const clearArea = () => write(K.DELETE_IMAGES + "\x1b[2;1H\x1b[J");

// The picture fitted whole below the top line, centred across.
function layoutPicture() {
  if (!S.cellW || !S.page) return void Object.assign(S, { imgCells: null, rect: null });
  const { w: aw, h: ah } = areaPx();
  const s = Math.min(aw / S.page.w, ah / S.page.h);
  const cols = Math.max(1, Math.min(S.cols, Math.round((S.page.w * s) / S.cellW)));
  const rows = Math.max(1, Math.min(areaRows(), Math.round((S.page.h * s) / S.cellH)));
  const col = Math.floor((S.cols - cols) / 2);
  const next = { col, row: 1, cols, rows };
  if (JSON.stringify(next) !== JSON.stringify(S.imgCells)) {
    clearArea();
    S.imgCells = next;
  }
  S.rect = { x: col * S.cellW, y: S.cellH, w: cols * S.cellW, h: rows * S.cellH };
}

// Every label is viewer text, still written through safeText so no control character reaches the terminal.
function button(row, x, label, fn, style) {
  label = K.safeText(label);
  write(`\x1b[${row + 1};${x + 1}H\x1b[${style}m${label}\x1b[0m`);
  S.buttons.push({ row, x0: x, x1: x + K.textWidth(label), fn });
}

function paint() {
  if (quitting) return;
  S.buttons = [];
  if (S.phase !== "live") {
    clearArea();
    S.imgCells = null;
    const msg = S.phase === "error" ? (S.code === "outside-root" ? tr("viewer.outside") : tr("viewer.failed", { code: S.code }))
      : S.phase === "restarting" ? tr("viewer.restarting")
      : S.phase === "loading" ? tr("viewer.loading") : tr("viewer.starting");
    const row = Math.max(1, Math.floor(S.rows / 2) - 1);
    const text = K.fitEnd(msg, S.cols - 2);
    write(`\x1b[${row + 1};${Math.max(1, Math.floor((S.cols - K.textWidth(text)) / 2) + 1)}H\x1b[2m${text}\x1b[0m`);
    if (S.phase === "error" && S.code !== "outside-root") {
      const label = ` ${tr("viewer.retry")} `;
      button(row + 2, Math.max(0, Math.floor((S.cols - K.textWidth(label)) / 2)), label, retry, "7");
    }
  }
  bar();
}

// The top line: what is shown on the left, then Reload, Open in browser and the error count; while
// a dialog waits, its question with OK and Cancel. Text from the page reaches it only through
// fitEnd/fitStart, which make it safe (kitty.mjs safeText).
function bar() {
  if (quitting) return;
  S.buttons = S.buttons.filter((b) => b.row !== 0);
  const W = S.cols;
  const errs = S.errors === 0 ? tr("viewer.noErrors") : S.errors === 1 ? tr("viewer.errors.one") : tr("viewer.errors.many", { n: S.errors });
  const errStyle = S.errors ? "31" : "2";
  const d = dialogs.pending;
  let btns = d ? [[tr("viewer.accept"), () => dialogs.answer(true), "7"], [tr("viewer.dismiss"), () => dialogs.answer(false), "7"]]
    : [[`↻ ${tr("viewer.reload")}`, reload, "4"], [`↗ ${tr("viewer.openInBrowser")}`, openInBrowser, "4"], [errs, toggleError, errStyle]];
  const width = (list) => list.reduce((n, [l]) => n + K.textWidth(l) + 2, 0);
  if (!d && W - width(btns) < 16) btns = [["↻", reload, "4"], ["↗", openInBrowser, "4"], [S.errors ? `✕${S.errors}` : "✓", toggleError, errStyle]];
  const room = Math.max(0, W - width(btns) - 2);
  let left, style;
  if (d) [left, style] = [K.fitEnd(d.type === "beforeunload" ? tr("viewer.leave") : tr("viewer.ask", { message: d.message }), room), "1;33"];
  else if (S.notice && Date.now() < S.noticeUntil) [left, style] = [K.fitEnd(S.notice, room), "33"];
  else if (S.showError && S.lastError) [left, style] = [K.fitEnd(S.lastError.replace(/\s+/g, " "), room), "31"];
  else {
    const shown = displayPath(S.url, { origin: server?.origin, root: ROOT, file: FILE, home: HOME });
    [left, style] = [K.fitStart(shown + (S.missing ? ` ${tr("viewer.missing")}` : ""), room), S.missing ? "31" : "2"];
  }
  write(`\x1b[1;1H\x1b[2K \x1b[${style}m${left}\x1b[0m`);
  let x = W - width(btns) + 1;
  for (const [label, fn, st] of btns) {
    button(0, x, label, fn, st);
    x += K.textWidth(label) + 2;
  }
}

function note(text, ms = 3500) {
  S.notice = text;
  S.noticeUntil = Date.now() + ms;
  bar();
  setTimeout(bar, ms + 20);
}

function setPhase(phase, code = "") {
  if (S.phase === phase && S.code === code) return;
  S.phase = phase;
  S.code = code;
  if (phase !== "live") Object.assign(S, { page: null, rect: null });
  else clearArea();
  paint();
}

let resizeTimer = null;
function resized() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => (layoutPicture(), paint(), cast.sync()), 60);
}
// The size asked of the terminal itself: a SIGWINCH that came before this handler was set is lost.
function sizeChanged() {
  const [cols, rows] = out.isTTY ? out.getWindowSize() : [S.cols, S.rows];
  if (!(cols > 0 && rows > 0) || (cols === S.cols && rows === S.rows)) return false;
  S.cols = cols;
  S.rows = rows;
  return true;
}
// The cell size (`CSI 16t`, answered as a "cell" event). Herdr answers a default 9×18 until the
// terminal is shown with real metrics, which can come after the resize itself; so it is asked again
// after each resize, on focus, and every 2 s, and only a changed answer redraws.
const askCell = () => write("\x1b[16t");
let askTimers = [];
function checkSize(force) {
  const changed = sizeChanged();
  askCell();
  if (!changed && !force) return;
  for (const t of askTimers) clearTimeout(t);
  askTimers = [250, 1000].map((ms) => setTimeout(askCell, ms));
  resized();
}
process.on("SIGWINCH", () => checkSize(true));

// ---- the page: viewport, screencast, frames ----

// Retina when a cell is at least 24 device pixels tall.
const scale = () => Number(process.env.LAZULI_VIEW_SCALE) || (S.cellH >= 24 ? 2 : 1);

// One frame: the page's CSS size lays the picture out; drawn as one Kitty image replaced in place.
function drawFrame(f, done) {
  const m = f.metadata ?? {};
  const page = { w: Math.round(m.deviceWidth), h: Math.round(m.deviceHeight) };
  if (!(page.w > 0 && page.h > 0) || quitting) return false;
  if (S.phase !== "live") setPhase("live");
  if (!S.page || page.w !== S.page.w || page.h !== S.page.h) {
    S.page = page;
    layoutPicture();
  }
  if (!S.imgCells) return false;
  if (write(K.imageSequence(f.data, S.imgCells))) done();
  else out.once("drain", done);
  return true;
}

// A frame must be the picture area in device pixels (live, Herdr drew the PNG at its own pixel size,
// c/r not scaling it): the CSS viewport is the area over the scale, rendered at that scale (the
// broker's Chrome makes screencast frames follow the emulated factor). The first frames of each
// page ask the pane's size again, in case it changed while the viewer started.
const cast = createCast({
  fps: FPS,
  want: () => (S.cellW ? viewFor(areaPx().w, areaPx().h, scale()) : null),
  draw: drawFrame,
  firstFrames: () => checkSize(false),
});

function navigate(url) {
  V.navAt = Date.now();
  fire("Page.navigate", { url });
}

function cancelScroll() {
  V.scroll = null;
  for (const t of V.scrollTimers) clearTimeout(t);
  V.scrollTimers = [];
}

// After a load: the scroll position from before a reload (again as late content settles), and a
// fresh screencast if no frame came since the navigation began.
function afterLoad() {
  const gen = V.gen;
  if (V.scroll) {
    const [x, y] = V.scroll;
    for (const ms of [0, 150, 600, 1500]) {
      V.scrollTimers.push(setTimeout(() => {
        if (gen === V.gen && V.scroll) fire("Runtime.evaluate", { expression: `scrollTo(${x}, ${y})` });
      }, ms));
    }
    V.scrollTimers.push(setTimeout(() => (V.scroll = null), 1600));
  }
  setTimeout(() => {
    if (gen === V.gen && cast.lastFrameAt < V.navAt) cast.sync(true);
  }, 400);
}

async function reload() {
  if (!V.cdp) return;
  cancelScroll();
  try {
    const v = (await call("Runtime.evaluate", { expression: "[scrollX, scrollY]", returnByValue: true })).result?.value;
    const x = Number(v?.[0]) || 0, y = Number(v?.[1]) || 0;
    V.scroll = x || y ? [x, y] : null;
  } catch {}
  V.navAt = Date.now();
  fire("Page.reload", { ignoreCache: true });
}

async function history(delta) {
  try {
    const h = await call("Page.getNavigationHistory");
    const e = h.entries?.[h.currentIndex + delta];
    if (e) fire("Page.navigateToHistoryEntry", { entryId: e.id });
  } catch {}
}

let lastOpen = { url: "", at: 0 };
function openExternal(url) {
  if (url === lastOpen.url && Date.now() - lastOpen.at < 1500) return;
  lastOpen = { url, at: Date.now() };
  execFile(process.platform === "darwin" ? "open" : "xdg-open", [url], () => {});
  note(tr("viewer.opened", { url }));
}
function openInBrowser() {
  if (server) openExternal(/^https?:/i.test(S.url) ? S.url : pageUrl());
}

// Main-frame document requests: this server's pages go on; other http(s) pages open outside.
function gate(p) {
  const url = String(p.request?.url ?? "");
  if (p.frameId === V.mainFrame && /^https?:/i.test(url) && !sameOrigin(url)) {
    fire("Fetch.failRequest", { requestId: p.requestId, errorReason: "Aborted" });
    openExternal(url);
  } else fire("Fetch.continueRequest", { requestId: p.requestId });
}
// A new window (target=_blank, window.open): followed here when same-origin, else opened outside.
function follow(url) {
  if (sameOrigin(url)) navigate(url);
  else if (/^https?:/i.test(url)) openExternal(url);
}

function addError(text) {
  Object.assign(S, { errors: S.errors + 1, lastError: String(text ?? "").slice(0, 500) });
  bar();
}
function toggleError() {
  S.showError = S.errors > 0 && !S.showError;
  bar();
}

function colorScheme() {
  if (V.cdp && S.dark !== null) fire("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: S.dark ? "dark" : "light" }] });
}

// ---- connection: lease, CDP session, recovery ----

function detach() {
  V.gen++;
  const c = V.cdp;
  Object.assign(V, { cdp: null, session: null, mainFrame: null });
  cast.reset();
  c?.close();
  dialogs.closed();
}

async function attach(browserWs, targetId, url) {
  detach();
  const gen = V.gen;
  const cdp = await connectCdp(browserWs);
  if (gen !== V.gen || quitting) {
    cdp.close();
    return;
  }
  V.cdp = cdp;
  V.targetId = targetId;
  // A closed connection with no chrome-exit right behind it means the page is gone: start over.
  cdp.onClose(() => setTimeout(() => {
    if (gen === V.gen && !quitting) recover("cdp-closed");
  }, 1000));
  const { sessionId: s } = await cdp.call("Target.attachToTarget", { targetId, flatten: true });
  if (gen !== V.gen) return;
  V.session = s;
  cast.reset(cdp, s);
  const on = (method, fn) => cdp.on(method, (p, sid) => {
    if (sid === s && gen === V.gen) fn(p);
  });
  on("Page.screencastFrame", (p) => cast.frame(p));
  on("Page.frameNavigated", (p) => {
    if (p.frame?.parentId) return;
    Object.assign(S, { url: p.frame?.url ?? "", errors: 0, lastError: "", showError: false });
    cast.navigated();
    bar();
  });
  on("Page.navigatedWithinDocument", (p) => {
    if (p.frameId !== V.mainFrame) return;
    S.url = p.url;
    bar();
  });
  on("Page.loadEventFired", afterLoad);
  on("Page.windowOpen", (p) => follow(String(p.url ?? "")));
  on("Page.javascriptDialogOpening", (p) => dialogs.opened(p));
  on("Page.javascriptDialogClosed", () => dialogs.closed());
  on("Runtime.exceptionThrown", (p) => addError(p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text));
  on("Runtime.consoleAPICalled", (p) => {
    if (p.type === "error" || p.type === "assert") addError((p.args ?? []).map((a) => a.value ?? a.description ?? "").join(" "));
  });
  // Network errors count too, except the favicon Chrome asks for on its own.
  on("Log.entryAdded", (p) => {
    const e = p.entry;
    if (e?.level === "error" && !/\/favicon\.ico(?:[?#]|$)/.test(e.url ?? "")) addError(`${e.text}${e.url ? ` (${e.url})` : ""}`);
  });
  on("Fetch.requestPaused", gate);
  on("Inspector.targetCrashed", () => navigate(shownUrl()));
  cdp.on("Target.targetCreated", (p, sid) => {
    const t = p.targetInfo;
    if (!sid && gen === V.gen && t?.openerId === targetId) cdp.call("Target.closeTarget", { targetId: t.targetId }).catch(() => {});
  });
  cdp.on("Target.targetDestroyed", (p, sid) => {
    if (!sid && gen === V.gen && p.targetId === targetId) recover("tab-closed");
  });
  await Promise.all([
    cdp.call("Page.enable", {}, s),
    cdp.call("Runtime.enable", {}, s),
    cdp.call("Log.enable", {}, s),
    cdp.call("Inspector.enable", {}, s),
    cdp.call("Emulation.setFocusEmulationEnabled", { enabled: true }, s),
    cdp.call("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] }, s),
    cdp.call("Target.setDiscoverTargets", { discover: true }),
  ]);
  cdp.call("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
  const tree = await cdp.call("Page.getFrameTree", {}, s);
  if (gen !== V.gen) return;
  V.mainFrame = tree.frameTree?.frame?.id ?? targetId;
  colorScheme();
  setPhase("loading");
  await cast.sync();
  navigate(url);
}

function leaseEvent(ev, lease) {
  if (lease !== V.lease || quitting) return;
  if (ev.type === "chrome-exit") {
    detach();
    setPhase("restarting");
  } else if (ev.type === "chrome-ready") {
    attach(ev.browserWs, ev.targetId, shownUrl()).catch(() => recover("chrome-failed"));
  } else if (ev.type === "lost") recover("lease-lost");
}

async function connect() {
  const lease = await acquireLease({ fid: FID, brokerPath: BROKER, onEvent: leaseEvent });
  if (quitting) return lease.close();
  V.lease = lease;
  return attach(lease.browserWs, lease.targetId, shownUrl());
}

let recovering = false;
let failures = [];
async function recover(reason) {
  if (quitting || recovering) return;
  recovering = true;
  detach();
  try { V.lease?.close(); } catch {}
  V.lease = null;
  const now = Date.now();
  failures = failures.filter((t) => now - t < 60000).concat(now);
  if (failures.length > 3) setPhase("error", reason);
  else {
    setPhase("starting");
    await connect().catch((e) => setPhase("error", e?.code ?? reason));
  }
  recovering = false;
}
// Retry after a failed setup (served folder, static server) does the setup again, then the browser;
// once the server is up it only reconnects the browser. outside-root offers no Retry (paint).
function retry() {
  failures = [];
  if (server) recover("retry");
  else start();
}

// ---- input ----

const input = createPageInput({
  fire,
  evaluate: async (expression) => (await call("Runtime.evaluate", { expression, returnByValue: true })).result?.value,
  live: () => !!V.cdp && S.phase === "live" && !dialogs.pending,
  view: () => S,
  reload,
  history,
  copied: () => note(tr("viewer.copied"), 1500),
  touched: cancelScroll,
});

const parser = K.createInputParser((ev) => {
  if (dialogs.input(ev)) return;
  if (ev.type === "text") input.text(ev.text);
  else if (ev.type === "key") input.key(ev.key, ev.mods);
  else if (ev.type === "mouse") input.mouse(ev.b, ev.x, ev.y, ev.release);
  else if (ev.type === "paste") input.paste(ev.text);
  else if (ev.type === "mode" && ev.mode === 1016) S.pixelMouse = ev.state === 1 || ev.state === 3;
  else if (ev.type === "cell") setCell(ev.w, ev.h);
  else if (ev.type === "focus") {
    if (ev.focused) askCell();
  } else if (ev.type === "bg") {
    S.dark = 0.2126 * ev.r + 0.7152 * ev.g + 0.0722 * ev.b < 0.5;
    colorScheme();
  }
});

function setCell(w, h) {
  if (w === S.cellW && h === S.cellH) return;
  Object.assign(S, { cellW: w, cellH: h });
  resized();
}

// ---- start ---- (raw before any question, so no answer arrives in canonical mode, held back and echoed)
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.on("data", (d) => parser.push(d));
process.stdin.resume();
write(K.setupSequence());
sizeChanged();
setInterval(() => checkSize(false), 2000);
paint();
followLanguage(opt("--settings") || defaultSettingsPath(), lang, (next) => {
  lang = next;
  paint();
});
// No answer to the cell-size question: a guess, so the picture still shows; any answer replaces it.
setTimeout(() => S.cellW || setCell(9, 18), 800);
start();

// The served folder and its static server (a failure shows its code), then the browser lease.
async function start() {
  setPhase("starting");
  const found = await findRoot(FILE);
  if (found.error) return setPhase("error", found.error);
  ({ root: ROOT, rel: REL } = found);
  try {
    server = await startStaticServer({ root: ROOT });
  } catch {
    return setPhase("error", "server-failed");
  }
  S.missing = !watchFile(FILE, (exists) => {
    S.missing = !exists;
    bar();
    if (exists) reload();
  }).exists;
  bar();
  return connect().catch((e) => setPhase("error", e?.code ?? "chrome-failed"));
}
