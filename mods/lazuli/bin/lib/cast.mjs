// The shown page's screencast in the HTML viewer (DESIGN B7): the page's viewport and the frames'
// size follow the picture area; frames are drawn one at a time, at most `fps` a second (the newest
// waits, and an older one not drawn yet is acked unseen, so Chrome sends the next only as they are
// drawn); and a frame of the wrong size restarts the screencast.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The view for a picture area of `w`×`h` device pixels at scale `dsf`: the CSS viewport
 *  `width`×`height` that, rendered at `dsf`, fills it (frames are then the area's size). */
export function viewFor(w, h, dsf) {
  const width = Math.max(64, Math.floor(w / dsf)), height = Math.max(32, Math.floor(h / dsf));
  return { w: Math.round(w), h: Math.round(h), dsf, width, height, key: `${width}x${height}@${dsf}` };
}

/** `want()`: the view wanted now (viewFor), or null while the area is unknown. `draw(frame, done)`:
 *  draws one frame (`{data, metadata}`, PNG in base64) and calls `done()` once written; returns false
 *  when it drew nothing. `firstFrames()`: called for each of the first three frames of a page. */
export function createCast({ fps, want, draw, firstFrames }) {
  let cdp = null, session = null, gen = 0, viewport = "", seq = 0;
  let pending = null, drawing = false, lastDraw = 0, timer = null, frames = 0;
  let heal = { key: "", count: 0, at: 0 };

  const ack = (f) => {
    if (cdp && f.session === session) cdp.call("Page.screencastFrameAck", { sessionId: f.p.sessionId }, session).catch(() => {});
  };

  // A frame whose PNG is not the wanted size (beyond 2 px) restarts the screencast, at most three
  // times per view and once a second, in case a start was lost.
  function checkSize(data) {
    const v = want();
    if (!v) return;
    const b = Buffer.from(data.slice(0, 32), "base64");
    if (Math.abs(b.readUInt32BE(16) - v.width * v.dsf) <= 2 && Math.abs(b.readUInt32BE(20) - v.height * v.dsf) <= 2) return;
    if (heal.key !== v.key) heal = { key: v.key, count: 0, at: 0 };
    if (heal.count >= 3 || Date.now() - heal.at < 1000) return;
    heal = { key: v.key, count: heal.count + 1, at: Date.now() };
    api.sync(true);
  }

  function pump() {
    if (drawing || !pending) return;
    const wait = lastDraw + 1000 / fps - Date.now();
    if (wait > 0) {
      if (!timer) timer = setTimeout(() => { timer = null; pump(); }, wait);
      return;
    }
    const f = pending;
    pending = null;
    if (f.session !== session) return;
    if (frames++ < 3) firstFrames();
    checkSize(f.p.data);
    drawing = true;
    lastDraw = Date.now();
    const drawn = draw(f.p, () => {
      drawing = false;
      ack(f);
      pump();
    });
    if (!drawn) {
      drawing = false;
      ack(f);
    }
  }

  const api = {
    /** When the last frame came (ms). */
    lastFrameAt: 0,
    /** The page connection frames come from (`cdp` client and its session), or none. */
    reset(c = null, s = null) {
      gen++;
      api.lastFrameAt = 0;
      cdp = c;
      session = s;
      viewport = "";
      pending = null;
      drawing = false;
      frames = 0;
      clearTimeout(timer);
      timer = null;
    },
    /** Brings the viewport and the screencast to the wanted view (`force`: restart the screencast
     *  even when the view is the same). A newer call stops an older one before its next step, so a
     *  slow start (Chrome refuses while a navigation swaps the page) never ends with the screencast
     *  limited to an earlier, smaller pane. */
    async sync(force = false) {
      const v = want();
      if (!cdp || !v || (v.key === viewport && !force)) return;
      const my = ++seq, g = gen;
      const current = () => my === seq && g === gen;
      const call = (method, params) => cdp.call(method, params, session);
      viewport = v.key;
      await call("Emulation.setDeviceMetricsOverride", { width: v.width, height: v.height, deviceScaleFactor: v.dsf, mobile: false, screenWidth: v.width, screenHeight: v.height }).catch(() => {});
      if (!current()) return;
      await call("Page.stopScreencast", {}).catch(() => {});
      for (let i = 0; i < 10 && current(); i++) {
        try {
          await call("Page.startScreencast", { format: "png", maxWidth: v.w, maxHeight: v.h, everyNthFrame: 1 });
          return;
        } catch {
          await sleep(200);
        }
      }
    },
    /** Page.screencastFrame of the current session. */
    frame(p) {
      if (pending) ack(pending);
      pending = { p, session };
      api.lastFrameAt = Date.now();
      pump();
    },
    /** A new document in the main frame (load, reload, link): its first frames count again. */
    navigated() {
      frames = 0;
    },
  };
  return api;
}
