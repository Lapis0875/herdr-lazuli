// Line-JSON framing for lazuli's sidecar sockets (ARCHITECTURE §5, CONTRACTS proto.js and C8): bytes in,
// complete UTF-8 lines out, with its own decoder because QuickJS has no TextDecoder (S4); replies and
// events told apart; PDF daemon requests checked before they are sent. Pure.

/** The longest line, in bytes without its newline, a framer accepts. */
export const MAX_LINE = 1048576;

const REPLACEMENT = 0xfffd;
const FLUSH = 8192;

/** UTF-8 bytes → string. A malformed sequence becomes one U+FFFD per maximal invalid subpart (as
 *  WHATWG's decoder does); a byte order mark is kept. Anything but a Uint8Array → "". */
export function utf8Decode(bytes) {
  if (!(bytes instanceof Uint8Array)) return "";
  let out = "";
  let units = [];
  const push = (u) => {
    units.push(u);
    if (units.length >= FLUSH) {
      out += String.fromCharCode.apply(null, units);
      units = [];
    }
  };
  const n = bytes.length;
  let i = 0;
  while (i < n) {
    const b = bytes[i];
    if (b < 0x80) {
      push(b);
      i++;
      continue;
    }
    let need = 0;
    let cp = 0;
    let lower = 0x80;
    let upper = 0xbf;
    if (b >= 0xc2 && b <= 0xdf) {
      need = 1;
      cp = b & 0x1f;
    } else if (b >= 0xe0 && b <= 0xef) {
      need = 2;
      cp = b & 0x0f;
      if (b === 0xe0) lower = 0xa0;
      if (b === 0xed) upper = 0x9f;
    } else if (b >= 0xf0 && b <= 0xf4) {
      need = 3;
      cp = b & 0x07;
      if (b === 0xf0) lower = 0x90;
      if (b === 0xf4) upper = 0x8f;
    } else {
      push(REPLACEMENT);
      i++;
      continue;
    }
    let j = i + 1;
    let got = 0;
    while (got < need && j < n) {
      const c = bytes[j];
      if (c < lower || c > upper) break;
      lower = 0x80;
      upper = 0xbf;
      cp = (cp << 6) | (c & 0x3f);
      got++;
      j++;
    }
    if (got < need) {
      // The offending byte, if any, starts the next sequence.
      push(REPLACEMENT);
      i = j;
      continue;
    }
    if (cp >= 0x10000) {
      const v = cp - 0x10000;
      push(0xd800 + (v >> 10));
      push(0xdc00 + (v & 0x3ff));
    } else {
      push(cp);
    }
    i = j;
  }
  if (units.length) out += String.fromCharCode.apply(null, units);
  return out;
}

function joinParts(parts, size, tail) {
  if (parts.length === 0) return tail;
  const all = new Uint8Array(size + tail.length);
  let at = 0;
  for (const p of parts) {
    all.set(p, at);
    at += p.length;
  }
  all.set(tail, at);
  return all;
}

/** A framer: push() takes bytes as they arrive and returns the lines they complete, decoded, without
 *  their "\n". The unfinished rest is held, across split multi-byte characters too. A line over `max`
 *  bytes gives error "line-too-long" (with the lines completed before it); every later push returns
 *  the same error and no lines. */
export function createFramer(max = MAX_LINE) {
  const limit = typeof max === "number" && max >= 0 ? max : MAX_LINE;
  let parts = [];
  let size = 0;
  let failed = false;
  const fail = (lines) => {
    failed = true;
    parts = [];
    size = 0;
    return { lines, error: "line-too-long" };
  };
  return {
    push(bytes) {
      if (failed) return { lines: [], error: "line-too-long" };
      const lines = [];
      if (!(bytes instanceof Uint8Array)) return { lines, error: null };
      let start = 0;
      for (let i = 0; i < bytes.length; i++) {
        if (bytes[i] !== 0x0a) continue;
        if (size + (i - start) > limit) return fail(lines);
        lines.push(utf8Decode(joinParts(parts, size, bytes.subarray(start, i))));
        parts = [];
        size = 0;
        start = i + 1;
      }
      if (start < bytes.length) {
        size += bytes.length - start;
        if (size > limit) return fail(lines);
        // A copy: the caller may reuse its buffer.
        parts.push(bytes.slice(start));
      }
      return { lines, error: null };
    },
  };
}

/** One request or reply as a line: JSON.stringify(msg) + "\n" (JSON never holds a raw newline). */
export function encode(msg) {
  return `${JSON.stringify(msg)}\n`;
}

const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** A received line → an answer to request `id` (`ok` with the rest as `value`, or an `error`), an
 *  unsolicited `event`, or `{bad: true}` for anything that is not a JSON object of either kind. An
 *  answer without `id` gets `id: null`. */
export function parseReply(line) {
  if (typeof line !== "string") return { bad: true };
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return { bad: true };
  }
  if (!isPlain(msg)) return { bad: true };
  const { id, error, event, ...value } = msg;
  if (typeof event === "string") return { event, value };
  if (event !== undefined) return { bad: true };
  if (error !== undefined) {
    if (!isPlain(error) || typeof error.code !== "string") return { bad: true };
    return {
      id: id ?? null,
      ok: false,
      error: { code: error.code, message: typeof error.message === "string" ? error.message : "" },
    };
  }
  return { id: id ?? null, ok: true, value };
}

/** The PDF daemon's operations and the fields each requires (`id` aside). Optional: search `limit`. */
export const PDF_OPS = Object.freeze({
  hello: Object.freeze(["token"]),
  open: Object.freeze(["path"]),
  render: Object.freeze(["doc", "page", "width"]),
  search: Object.freeze(["doc", "query"]),
  links: Object.freeze(["doc", "page"]),
  outline: Object.freeze(["doc"]),
  text: Object.freeze(["doc", "page"]),
  close: Object.freeze(["doc"]),
  ping: Object.freeze([]),
});

const nonEmpty = (v) => typeof v === "string" && v !== "";
const positiveInt = (v) => Number.isInteger(v) && v > 0;

// A field counts as present only with the type the daemon reads.
const FIELD = Object.freeze({
  token: nonEmpty,
  path: nonEmpty,
  doc: nonEmpty,
  query: nonEmpty,
  page: positiveInt,
  width: positiveInt,
});

/** A PDF daemon request → null when it can be sent; "bad-op" when it is not an object with a known
 *  `op`; "missing-field" when a required field is absent or of the wrong type. */
export function checkRequest(msg) {
  if (!isPlain(msg) || typeof msg.op !== "string" || !Object.prototype.hasOwnProperty.call(PDF_OPS, msg.op)) {
    return "bad-op";
  }
  for (const field of PDF_OPS[msg.op]) {
    if (!FIELD[field](msg[field])) return "missing-field";
  }
  return null;
}
