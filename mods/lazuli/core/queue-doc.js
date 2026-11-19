// Each agent's prompt queue (ARCHITECTURE §4.7): follow-ups written while it works, sent one at a time or all at once
// as one numbered prompt. The document holds them by terminal address: {version: 1, queues: {"t3": [{id, text, at}]}}.
//
// A port of cockpit v0.38.5 `herdr/tui/cli/src/queue.rs` (`prompt`, `edit`), with codes instead of sentences (C3).
// The caller writes the result, delivers `texts` with `hc send`, and puts the previous doc back when that fails.

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const EDGES = /^\p{White_Space}+|\p{White_Space}+$/gu;

// A key such as "__proto__" stays an own property instead of setting the prototype.
function put(obj, key, value) {
  Object.defineProperty(obj, key, { value, enumerable: true, writable: true, configurable: true });
}

const isItem = (v) => isPlain(v) && typeof v.id === "string" && typeof v.text === "string" && typeof v.at === "number" && Number.isFinite(v.at);

/** A document with no queues. */
export function emptyDoc() {
  return { version: 1, queues: {} };
}

/** Any parsed value → a document: queues that are lists keep their `{id, text, at}` items (strings, a number); the
 *  rest, and queues left empty, are dropped. */
export function normalize(raw) {
  const doc = emptyDoc();
  const queues = isPlain(raw) && isPlain(raw.queues) ? raw.queues : {};
  for (const handle of Object.keys(queues)) {
    const list = Array.isArray(queues[handle]) ? queues[handle].filter(isItem).map(({ id, text, at }) => ({ id, text, at })) : [];
    if (list.length > 0) put(doc.queues, handle, list);
  }
  return doc;
}

/** How many prompts wait, over every queue. */
export function count(doc) {
  const queues = isPlain(doc) && isPlain(doc.queues) ? doc.queues : {};
  return Object.keys(queues).reduce((n, h) => n + (Array.isArray(queues[h]) ? queues[h].length : 0), 0);
}

/** The prompt that sends these items: the one alone, several numbered. */
export function prompt(texts) {
  if (!Array.isArray(texts)) return "";
  if (texts.length === 1) return String(texts[0]);
  return texts.map((t, i) => `${i + 1}. ${t}`).join("\n");
}

const ACTIONS = ["add", "edit", "remove", "move", "clear", "send"];

/** One edit of the queues: `add [h, text]`, `edit [h, id, text]`, `remove [h, id]`, `move [h, id, to]`, `clear [h]`,
 *  `send [h, id | "all"]` (an empty id is "all"). Returns `{doc, note, texts}`, `texts` being what `send` took out of
 *  the doc; or `{error}` when the edit did nothing. */
export function edit(doc, action, args, now) {
  const list = Array.isArray(args) ? args : [];
  const arg = (i) => (typeof list[i] === "string" ? list[i].replace(EDGES, "") : "");
  const handle = arg(0);
  if (handle === "") return { error: "no-agent" };
  if (!ACTIONS.includes(action)) return { error: "unknown-action" };
  const next = normalize(doc);
  const items = own(next.queues, handle) ? next.queues[handle] : [];
  const index = (id) => items.findIndex((i) => i.id === id);
  const done = (note, texts = []) => {
    if (items.length > 0) put(next.queues, handle, items);
    else delete next.queues[handle];
    return { doc: next, note, texts };
  };
  switch (action) {
    case "add": {
      const text = arg(1);
      if (text === "") return done("nothing-to-add");
      items.push({ id: `q${now}-${items.length}`, text, at: now });
      return done("queued");
    }
    case "edit": {
      const at = index(arg(1));
      if (at < 0) return { error: "not-in-queue" };
      items[at] = { ...items[at], text: arg(2) };
      return done("");
    }
    case "remove": {
      const at = index(arg(1));
      if (at < 0) return { error: "not-in-queue" };
      items.splice(at, 1);
      return done("");
    }
    case "move": {
      const at = index(arg(1));
      if (at < 0) return { error: "not-in-queue" };
      const to = Number.isInteger(list[2]) && list[2] >= 0 ? list[2] : 0;
      const [item] = items.splice(at, 1);
      items.splice(Math.min(to, items.length), 0, item);
      return done("");
    }
    case "clear":
      items.length = 0;
      return done("");
    default: {
      const which = arg(1);
      let taken;
      if (which === "" || which === "all") taken = items.splice(0, items.length);
      else {
        const at = index(which);
        if (at < 0) return { error: "not-in-queue" };
        taken = items.splice(at, 1);
      }
      const texts = taken.map((i) => i.text);
      return done(texts.length === 0 ? "nothing-queued" : "sent", texts);
    }
  }
}
