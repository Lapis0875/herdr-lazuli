// One Hermes profile's connection to its bridge (CONTRACTS K3, K4; spike S8): the stream socket (hello, then every
// agent line as a record, read with `read(1048576)`), short send connections (at most MAX_PARALLEL_SENDS at a time,
// each line written in pieces of at most 1 MiB), and request/response matching for the requests whose answers the
// caller awaits. Prompts are not awaited here: their answers reach the caller as records, like everything else the
// agent writes.
//
// The stream: a Herdr `net` read pending 30 s without data fails with "os error 35" (S8); the bridge pings after 10 s
// of silence, so a read that fails that way is simply read again, and the stream counts as lost only after
// LOST_AFTER_TIMEOUTS such failures in a row or at its end. No timer runs per line or per read (Herdr allows 1,024
// outstanding host tasks per runtime, S8).
//
// Callers check `checking()` before using it: `net` throws under `herdr-app check` (S4).

import net from "net";
import { Buffer } from "buffer";
import * as wire from "../core/acp-wire.js";

/** Bytes asked of each read. */
const READ_BYTES = 1048576;
/** A stream line longer than this is dropped (the bridge never writes one: its records wrap lines ≤ 16 MiB). */
const MAX_RECORD = wire.MAX_LINE_BYTES + 65536;
/** A send connection's reply must come within this time. */
const SEND_REPLY_MS = 10000;
/** A shutdown request's reply. */
const SHUTDOWN_REPLY_MS = 5000;

const TIMEOUT = Object.freeze({ timeout: true });
const READ_TIMEOUT = /os error 35|temporarily unavailable|timed out/i;
const errText = (e) => e?.message ?? String(e);
const log = (msg) => console.log(`[lazuli/acp] ${msg}`);

/** `read()`'s result as bytes (the host gives a Uint8Array, S4). */
function bytesOf(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (typeof v === "string") return Uint8Array.from(Buffer.from(v, "utf8"));
  return new Uint8Array(0);
}

/** One socket's lines, parsed: `next()` resolves the next JSON value (a line that is not JSON is skipped), null at
 *  the end of the stream, and rejects when a read fails; the partial line is kept across a failed read. */
class Reader {
  constructor(sock) {
    this.sock = sock;
    this.parts = [];
    this.size = 0;
    this.lines = [];
    this.head = 0;
    this.eof = false;
    this.dropping = false;
  }

  push(u8) {
    let start = 0;
    for (;;) {
      const i = u8.indexOf(10, start);
      if (i < 0) {
        const rest = u8.length - start;
        if (rest > 0) {
          this.size += rest;
          if (this.size > MAX_RECORD) {
            this.dropping = true;
            this.parts = [];
          } else if (!this.dropping) this.parts.push(u8.subarray(start));
        }
        return;
      }
      const seg = u8.subarray(start, i);
      if (this.dropping || this.size + seg.length > MAX_RECORD) {
        log(`a line of ${this.size + seg.length} bytes was dropped`);
      } else if (this.parts.length) {
        const all = new Uint8Array(this.size + seg.length);
        let at = 0;
        for (const p of this.parts) {
          all.set(p, at);
          at += p.length;
        }
        all.set(seg, at);
        this.lines.push(all);
      } else this.lines.push(seg);
      this.parts = [];
      this.size = 0;
      this.dropping = false;
      start = i + 1;
    }
  }

  async next() {
    for (;;) {
      while (this.head < this.lines.length) {
        const raw = this.lines[this.head];
        this.lines[this.head++] = null;
        if (this.head > 256 && this.head * 2 > this.lines.length) {
          this.lines = this.lines.slice(this.head);
          this.head = 0;
        }
        if (raw.length === 0) continue;
        try {
          return JSON.parse(Buffer.from(raw).toString("utf8"));
        } catch {
          log(`a line of ${raw.length} bytes that is not JSON was skipped`);
        }
      }
      if (this.eof) return null;
      const got = await this.sock.read(READ_BYTES);
      if (got == null) {
        this.eof = true;
        continue;
      }
      this.push(bytesOf(got));
    }
  }
}

/** Opens a connection to the bridge and writes its first line, in pieces of at most 1 MiB (S8). */
async function openLine(port, value) {
  const sock = await net.connect("127.0.0.1", port);
  try {
    for (const piece of wire.writeChunks(wire.encodeLine(value))) await sock.write(piece);
  } catch (e) {
    try {
      sock.close();
    } catch {}
    throw e;
  }
  return sock;
}

/** A bridge's refusal of a first line → a service error code (K4). */
function sendError(code) {
  if (code === "auth") return "auth";
  if (code === "agent-gone") return "agent-exit";
  if (code === "too-large") return "too-long";
  return `rpc:${code || "bridge"}`;
}

/**
 * The client of one bridge.
 * - `onRecord(rec)`: every agent message the stream delivers that is not an answer awaited through `request()`:
 *   `{seq, at, msg, c}` with `c` = core/acp-wire.js classify(msg).
 * - `onEvent(ev)`: the bridge's events past `hello` and `ping` (`gap`, `dropped`, `agent-exit`, `bye`).
 * - `onEnd({reason, bye, agentExit, detail})`: the stream ended once: `reason` is `replaced` (a newer client took it),
 *   `bye` (the bridge said why in `bye`), `eof` or `lost` (read failures). Pending requests resolve `{error}` first.
 */
export class AcpClient {
  constructor({ profile, discovery, nonce, onRecord, onEvent, onEnd }) {
    this.profile = profile;
    this.d = discovery;
    this.ids = wire.createIds(nonce);
    this.onRecord = onRecord ?? (() => {});
    this.onEvent = onEvent ?? (() => {});
    this.onEnd = onEnd ?? (() => {});
    this.pending = new Map(); // request id → resolve
    this.active = 0; // send connections open
    this.waiting = []; // resolvers of sends waiting for a slot
    this.sock = null;
    this.hello = null;
    this.seq = null; // the last record seq seen
    this.open = false;
    this.ended = false;
    this.bye = null;
    this.agentExit = null;
  }

  get pid() {
    return this.d.pid;
  }

  /** Opens the stream (`since`: the last seq held, or null for live records only). Resolves `{ok, hello}` or
   *  `{error}` (`auth`, `disconnected`, `bridge-timeout` when no hello comes within HELLO_MS). The read loop then runs
   *  in a task no view owns. */
  async connect(cx, since = null) {
    let sock;
    try {
      sock = await openLine(this.d.port, wire.streamLine(this.d.token, since, "lazuli"));
    } catch (e) {
      return { error: "disconnected", detail: errText(e) };
    }
    const reader = new Reader(sock);
    let first;
    try {
      first = await Promise.race([reader.next(), cx.sleep(wire.HELLO_MS).then(() => TIMEOUT)]);
    } catch (e) {
      first = { failed: errText(e) };
    }
    const r = first === TIMEOUT || first === null ? null : wire.parseRecord(first);
    if (!r || r.kind !== "event" || r.ev !== "hello") {
      try {
        sock.close();
      } catch {}
      if (r?.kind === "reply" && r.error?.code === "auth") return { error: "auth" };
      return { error: first === TIMEOUT ? "bridge-timeout" : "disconnected", detail: first?.failed ?? null };
    }
    this.sock = sock;
    this.hello = first;
    this.seq = Number.isInteger(first.seq) ? first.seq : this.seq;
    this.open = true;
    cx.spawn((tcx) => this.loop(tcx, reader), { owner: null });
    return { ok: true, hello: first };
  }

  async loop(cx, reader) {
    let timeouts = 0;
    for (;;) {
      let v;
      try {
        v = await reader.next();
        timeouts = 0;
      } catch (e) {
        if (this.ended) return;
        const text = errText(e);
        if (READ_TIMEOUT.test(text) && ++timeouts < wire.LOST_AFTER_TIMEOUTS) continue;
        await this.end({ reason: "lost", detail: text }, cx);
        return;
      }
      if (this.ended) return;
      if (v === null) {
        await this.end({ reason: this.bye ? "bye" : "eof" }, cx);
        return;
      }
      let replaced = false;
      try {
        replaced = this.handle(v, cx) === "replaced";
      } catch (e) {
        log(`${this.profile}: a record failed: ${errText(e)}`);
      }
      if (replaced) {
        await this.end({ reason: "replaced" }, cx);
        return;
      }
    }
  }

  handle(v, cx) {
    const r = wire.parseRecord(v);
    if (r.kind === "agent") {
      this.seq = r.seq;
      const c = wire.classify(r.msg);
      if ((c.kind === "result" || c.kind === "error") && this.pending.has(String(c.id))) {
        const resolve = this.pending.get(String(c.id));
        this.pending.delete(String(c.id));
        resolve(c.kind === "result" ? { ok: true, result: c.result } : { error: `rpc:${c.error.code ?? "error"}`, message: c.error.message });
        return;
      }
      this.onRecord({ seq: r.seq, at: typeof r.at === "number" ? r.at : null, msg: r.msg, c }, cx);
      return;
    }
    if (r.kind !== "event" || r.ev === "ping" || r.ev === "hello") return;
    if (Number.isInteger(r.seq)) this.seq = r.seq;
    if (r.ev === "replaced") return "replaced";
    if (r.ev === "bye") this.bye = typeof r.reason === "string" ? r.reason : "?";
    if (r.ev === "agent-exit") this.agentExit = { code: r.code ?? null, signal: r.signal ?? null };
    this.onEvent(r, cx);
  }

  /** The stream ends once: pending requests are answered with the reason, then `onEnd`, awaited in the stream's task
   *  (its cx stays usable while the caller reconnects). */
  async end(why, cx) {
    if (this.ended) return;
    this.ended = true;
    this.open = false;
    try {
      this.sock?.close();
    } catch {}
    const code = this.agentExit || this.bye === "agent-exit" ? "agent-exit" : "disconnected";
    for (const resolve of this.pending.values()) resolve({ error: code });
    this.pending.clear();
    try {
      await this.onEnd({ ...why, bye: this.bye, agentExit: this.agentExit }, cx);
    } catch (e) {
      log(`${this.profile}: onEnd failed: ${errText(e)}`);
    }
  }

  /** Closes the stream without telling anyone (the service stops, or replaces this client). */
  close() {
    this.ended = true;
    this.open = false;
    for (const resolve of this.pending.values()) resolve({ error: "disconnected" });
    this.pending.clear();
    try {
      this.sock?.close();
    } catch {}
  }

  async slot() {
    if (this.active < wire.MAX_PARALLEL_SENDS) {
      this.active++;
      return;
    }
    await new Promise((resolve) => this.waiting.push(resolve));
  }

  release() {
    const next = this.waiting.shift();
    if (next) next();
    else this.active--;
  }

  /** One short connection: its first line, the bridge's one-line reply, close. Resolves the reply or `{error}`. */
  async exchange(cx, line, ms) {
    await this.slot();
    let sock = null;
    try {
      sock = await openLine(this.d.port, line);
      const reply = await Promise.race([new Reader(sock).next(), cx.sleep(ms).then(() => TIMEOUT)]);
      if (reply === TIMEOUT || reply === null) return { error: "disconnected" };
      const r = wire.parseRecord(reply);
      if (r.kind !== "reply") return { error: "disconnected" };
      return r.ok ? { ok: true } : { error: sendError(r.error.code) };
    } catch (e) {
      log(`${this.profile}: send failed: ${errText(e)}`);
      return { error: "disconnected" };
    } finally {
      try {
        sock?.close();
      } catch {}
      this.release();
    }
  }

  /** Writes one message to the agent. Resolves `{ok}` or `{error}`. */
  send(cx, msg) {
    if (this.ended && !this.open) return Promise.resolve({ error: this.agentExit ? "agent-exit" : "disconnected" });
    return this.exchange(cx, wire.sendLine(this.d.token, msg), SEND_REPLY_MS);
  }

  /** A new request id (`<nonce>:<n>`). */
  nextId() {
    return this.ids.next();
  }

  /** Sends a request and awaits its answer on the stream: `{ok, result}` or `{error}` (`rpc:<code>` for a JSON-RPC
   *  error, `bridge-timeout` past `timeoutMs`, a send error, or why the stream ended). */
  async request(cx, method, params, { timeoutMs = 30000 } = {}) {
    if (!this.open) return { error: this.agentExit ? "agent-exit" : "disconnected" };
    const id = this.nextId();
    const answer = new Promise((resolve) => this.pending.set(id, resolve));
    const sent = await this.send(cx, wire.request(id, method, params));
    if (sent.error) {
      this.pending.delete(id);
      return sent;
    }
    const r = await Promise.race([answer, cx.sleep(timeoutMs).then(() => TIMEOUT)]);
    this.pending.delete(id);
    return r === TIMEOUT ? { error: "bridge-timeout" } : r;
  }

  /** Asks the bridge to stop (K3 `shutdown`: running prompts cancelled first). Resolves `{ok}` or `{error}`. */
  shutdown(cx) {
    return this.exchange(cx, wire.shutdownLine(this.d.token), SHUTDOWN_REPLY_MS);
  }
}

/** `{op:"shutdown"}` to the bridge of a discovery, without a client. Resolves `{ok}` or `{error}`. */
export function shutdownBridge(cx, discovery) {
  return new AcpClient({ profile: discovery.profile, discovery, nonce: "x" }).shutdown(cx);
}
