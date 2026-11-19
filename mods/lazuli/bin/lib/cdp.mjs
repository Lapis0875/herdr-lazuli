// A Chrome DevTools Protocol client over one WebSocket (Node's global WebSocket), with flat
// sessions: `call(method, params, sessionId)` answers the result or rejects with a CdpError;
// `on(method, fn)` hears events as `fn(params, sessionId)`. Used by chrome-broker.mjs (tabs) and
// html-view.mjs (one page's screencast and input).

/** A failed call: `code` is "cdp-error" (Chrome refused; `message` is Chrome's), "cdp-closed" or "cdp-timeout". */
export class CdpError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

/** Opens `wsUrl` (a `ws://127.0.0.1:<port>/devtools/...` address). Rejects with CdpError
 *  "cdp-closed" when it cannot connect within `timeoutMs`. */
export function connectCdp(wsUrl, { timeoutMs = 10000, callTimeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      reject(new CdpError("cdp-closed", String(e?.message ?? e)));
      return;
    }
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new CdpError("cdp-closed", "connect timed out"));
    }, timeoutMs);
    ws.onerror = () => {};
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(new Cdp(ws, callTimeoutMs));
    };
    ws.onclose = () => {
      clearTimeout(timer);
      reject(new CdpError("cdp-closed", "connection refused"));
    };
  });
}

class Cdp {
  constructor(ws, callTimeoutMs) {
    this.ws = ws;
    this.callTimeoutMs = callTimeoutMs;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Map();
    this.closeListeners = new Set();
    this.closed = false;
    ws.onmessage = (e) => this.receive(e.data);
    ws.onclose = () => this.shut();
    ws.onerror = () => {};
  }

  receive(data) {
    if (typeof data !== "string") return;
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof msg.id === "number") {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new CdpError("cdp-error", msg.error.message));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (typeof msg.method !== "string") return;
    const set = this.listeners.get(msg.method);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(msg.params ?? {}, msg.sessionId ?? null);
      } catch (e) {
        process.stderr.write(`cdp listener ${msg.method}: ${e?.stack ?? e}\n`);
      }
    }
  }

  /** Sends one command; `sessionId` null addresses the browser. */
  call(method, params = {}, sessionId = null, { timeoutMs = this.callTimeoutMs } = {}) {
    if (this.closed) return Promise.reject(new CdpError("cdp-closed", method));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CdpError("cdp-timeout", method));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new CdpError("cdp-closed", String(e?.message ?? e)));
      }
    });
  }

  /** Calls `fn(params, sessionId)` for every `method` event. Returns a function that stops it. */
  on(method, fn) {
    let set = this.listeners.get(method);
    if (!set) this.listeners.set(method, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }

  /** Calls `fn()` once when the connection ends (at once when it already has). */
  onClose(fn) {
    if (this.closed) queueMicrotask(fn);
    else this.closeListeners.add(fn);
    return () => this.closeListeners.delete(fn);
  }

  close() {
    try { this.ws.close(); } catch {}
    this.shut();
  }

  shut() {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new CdpError("cdp-closed", "connection closed"));
    }
    this.pending.clear();
    for (const fn of [...this.closeListeners]) {
      try { fn(); } catch {}
    }
    this.closeListeners.clear();
  }
}
